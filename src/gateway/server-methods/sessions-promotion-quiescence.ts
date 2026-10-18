import {
  hasPendingPollDelivery,
  listFinishedSessions,
  listRunningSessions,
} from "../../agents/bash-process-registry.js";
import { hasCliSessionLifecycleCustody } from "../../agents/cli-runner/cli-live-session-registry.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { isEmbeddedAgentRunInProgress } from "../../agents/embedded-agent-runner/runs.js";
import { buildPendingGeneratedMediaSessionKeySet } from "../../agents/media-generation-activity.js";
import { isSubagentRunLifecycleSettled } from "../../agents/subagents/registry/subagent-delivery-state.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { withSubagentRunReadSnapshot } from "../../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { hasSessionLifecycleQueueWork } from "../../auto-reply/reply/queue/cleanup.js";
import { resolveReplyOperationsForSession } from "../../auto-reply/reply/reply-run-registry.js";
import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.js";
import { listAgentRunsForSession } from "../../infra/agent-run-registry.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import {
  inspectSessionWorkAdmissionPhases,
  isSessionWorkAdmissionActive,
} from "../../sessions/session-lifecycle-admission.js";
import { getWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import { hasGatewaySessionAbortOwner } from "./chat-abort-authorization.js";
import type { GatewayRequestContext } from "./types.js";

export type SessionPromotionProbeParams = {
  context: GatewayRequestContext;
  storePath: string;
  sessionKey: string;
  sessionKeys: string[];
  sessionId?: string;
  agentId: string;
  defaultAgentId?: string;
  lifecycleIdentities: string[];
  /**
   * Advisory pre-check: in-memory owner inventories only. Skips the asynchronous worker reads,
   * so it can only ever report more quiet than the authoritative probe, never settlement proof.
   * Neither probe runs inside the lifecycle fence; activation's synchronous `recheck` does.
   */
  quick?: boolean;
};

export type SessionPromotionBlocker = {
  code: string;
  owner: string;
  sessionKey?: string;
  runId?: string;
};

/** Follow requester edges, never siblings of the target's parent. */
function relevantRuns<R extends { childSessionKey: string; requesterSessionKey: string }>(
  roots: ReadonlySet<string>,
  rows: ReadonlyMap<string, R>,
): Array<[string, R]> {
  const keys = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows.values()) {
      if (keys.has(row.requesterSessionKey) && !keys.has(row.childSessionKey)) {
        keys.add(row.childSessionKey);
        changed = true;
      }
    }
  }
  return [...rows.entries()].filter(([, row]) => keys.has(row.childSessionKey));
}

type ProbeTarget = {
  sessionId?: string;
  agentId: string;
  storePath?: string;
  /** A descendant's canonical and physical store keys, which its admissions may use. */
  aliases?: string[];
};
type Add = (code: string, owner: string, sessionKey?: string, runId?: string) => void;

function createCollector() {
  const blockers: SessionPromotionBlocker[] = [];
  const add: Add = (code, owner, sessionKey, runId) => {
    blockers.push({
      code,
      owner,
      ...(sessionKey ? { sessionKey } : {}),
      ...(runId ? { runId } : {}),
    });
  };
  const read = <T>(owner: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      add("inventory-unavailable", owner);
      return undefined;
    }
  };
  return { blockers, add, read };
}

function inspectDelegationRow(add: Add, row: SubagentRunRecord) {
  // endedAt or cleanupCompletedAt alone prove nothing; only the registry's own composite
  // settlement predicate releases a row. A retained, fully settled historical row is
  // not a blocker (it never mutates the target again).
  if (!isSubagentRunLifecycleSettled(row)) {
    add("delegation-custody", "subagent-registry", row.childSessionKey, row.runId);
  }
  if (
    row.killIntent ||
    row.killReconciliation ||
    row.execution?.restartRecovery ||
    row.queuedLaunch ||
    row.collectorLaunchCleanupPending ||
    row.requesterSettleWake ||
    row.collectorCompletion
  ) {
    add("delegation-pending-effects", "subagent-registry", row.childSessionKey, row.runId);
  }
}

/**
 * Every owner inventory that can be read without awaiting. The probe runs it once; activation
 * runs it again under the store writer and right before the write, so work that became visible
 * while the asynchronous reads were outstanding still blocks the commit.
 */
function inspectSynchronousOwners(
  params: SessionPromotionProbeParams,
  roots: ReadonlySet<string>,
  targets: ReadonlyMap<string, ProbeTarget>,
  { add, read }: Pick<ReturnType<typeof createCollector>, "add" | "read">,
  options: { liveDelegations: boolean },
) {
  const phases = read("session-work-admissions", () =>
    inspectSessionWorkAdmissionPhases(params.storePath, [
      ...params.lifecycleIdentities,
      ...params.sessionKeys,
    ]),
  );
  if (phases?.pending) {
    add("pending-admission", "session-work-admissions");
  }
  if (phases?.acquired) {
    add("admission", "session-work-admissions");
  }
  if (
    read("session-work-admissions", () =>
      isSessionWorkAdmissionActive(params.storePath, [
        ...params.lifecycleIdentities,
        ...roots,
        params.sessionId,
      ]),
    )
  ) {
    add("admission", "session-work-admissions");
  }
  if (options.liveDelegations) {
    // The persisted snapshot needs an await; a delegation started since then is in memory.
    for (const [, row] of read("subagent-registry", () => relevantRuns(roots, subagentRuns)) ??
      []) {
      inspectDelegationRow(add, row);
    }
  }

  const media = read("generated-media-tasks", buildPendingGeneratedMediaSessionKeySet);
  for (const [sessionKey, target] of targets) {
    if (!roots.has(sessionKey)) {
      // A descendant may live in another agent's store; its pending or acquired admissions are
      // only visible under that store's lifecycle scope, never the root's.
      const descendantPhases = target.storePath
        ? read("session-work-admissions", () =>
            inspectSessionWorkAdmissionPhases(target.storePath!, [
              sessionKey,
              target.sessionId,
              ...(target.aliases ?? []),
            ]),
          )
        : undefined;
      if (descendantPhases?.pending) {
        add("pending-admission", "session-work-admissions", sessionKey);
      }
      if (descendantPhases?.acquired) {
        add("admission", "session-work-admissions", sessionKey);
      }
    }
    const sessionKeys = roots.has(sessionKey) ? [...roots] : [sessionKey];
    const scope = {
      sessionKeys,
      sessionId: target.sessionId,
      agentId: target.agentId,
      defaultAgentId: params.defaultAgentId,
    };
    // A retired handle for an older incarnation still owns process cleanup for this key.
    if (read("cli-live-session-registry", () => hasCliSessionLifecycleCustody({ sessionKey }))) {
      add("cli-session-custody", "cli-live-session-registry", sessionKey);
    }
    const terminals = params.context.terminalSessions;
    if (terminals) {
      if (typeof terminals.inspectAgentSessionWork !== "function") {
        add("terminal-inventory-unavailable", "agent-terminals", sessionKey);
      } else if (
        target.sessionId &&
        read("agent-terminals", () =>
          terminals.inspectAgentSessionWork({
            kind: "agent",
            agentSessionKey: sessionKey,
            agentSessionId: target.sessionId!,
            agentId: target.agentId,
          }),
        )
      ) {
        add("agent-terminal-custody", "agent-terminals", sessionKey);
      }
    }
    if (!target.sessionId) {
      add("session-incarnation-unavailable", "session-identity", sessionKey);
    }
    if (read("reply-operations", () => resolveReplyOperationsForSession(scope).length)) {
      add("reply", "reply-operations", sessionKey);
    }
    if (
      target.sessionId &&
      read("embedded-runs", () => isEmbeddedAgentRunInProgress(target.sessionId!))
    ) {
      add("embedded", "embedded-runs", sessionKey);
    }
    if (
      read(
        "agent-runs",
        () => listAgentRunsForSession({ sessionKey, sessionId: target.sessionId }).length,
      )
    ) {
      add("run", "agent-runs", sessionKey);
    }
    if (
      read("gateway-input", () =>
        hasGatewaySessionAbortOwner({ context: params.context, ...scope }),
      )
    ) {
      add("gateway-input", "gateway-input", sessionKey);
    }
    if (
      read("session-queues", () =>
        hasSessionLifecycleQueueWork({
          keys: [...sessionKeys, target.sessionId],
          sessionKey,
          sessionId: target.sessionId,
          agentId: target.agentId,
        }),
      )
    ) {
      add("queue", "session-queues", sessionKey);
    }
    // cleanup.ts counts queued entries only; an executing lane task is also work.
    if (
      read("command-lanes", () =>
        [...sessionKeys, target.sessionId].some(
          (key) => key && getCommandLaneSnapshot(resolveEmbeddedSessionLane(key)).activeCount > 0,
        ),
      )
    ) {
      add("queue", "command-lanes", sessionKey);
    }
    if (media?.has(sessionKey)) {
      add("task", "generated-media-tasks", sessionKey);
    }
    const sessionId = target.sessionId;
    const placements = params.context.workerSessionPlacementService;
    if (
      sessionId &&
      placements &&
      read("worker-placement", () => placements.getMany([sessionId]).get(sessionId)?.turnClaim)
    ) {
      add("worker-claim", "worker-placement", sessionKey);
    }
    if (sessionId && params.context.workerEnvironmentService) {
      const control = read("worker-inference", () =>
        getWorkerInferenceSessionControl(params.context.workerEnvironmentService),
      );
      if (!control) {
        add("worker-inference-inventory-unavailable", "worker-inference", sessionKey);
      } else if (read("worker-inference", () => control.hasSession(sessionId))) {
        add("worker-inference", "worker-inference", sessionKey);
      }
    }
  }

  const matchesProcess = (process: { sessionKey?: string; scopeKey?: string; agentId?: string }) =>
    [...targets].some(
      ([key, target]) =>
        (process.sessionKey === key || process.scopeKey === key) &&
        (!process.agentId || process.agentId === target.agentId),
    );
  for (const process of read("background-processes", listRunningSessions) ?? []) {
    if (matchesProcess(process)) {
      add("task", "background-processes", process.sessionKey);
    }
  }
  for (const process of read("finished-process-delivery", listFinishedSessions) ?? []) {
    if (matchesProcess(process)) {
      // Poll custody is one known effect; notify-on-exit settlement is not exposed.
      add("process-custody", "finished-process-delivery", process.sessionKey);
      if (read("finished-process-delivery", () => hasPendingPollDelivery(process))) {
        add("process-delivery", "finished-process-delivery", process.sessionKey);
      }
    }
  }
}

export type SessionPromotionQuiescence = {
  blockers: SessionPromotionBlocker[];
  /** Synchronous re-read of every in-memory owner for the same targets; callable under a writer. */
  recheck: () => SessionPromotionBlocker[];
};

/**
 * Read-only inventory, NOT an activation transaction or a settlement operation. It may await
 * (subagent snapshot, worker results), so activation runs it before the lifecycle fence and
 * calls `recheck` synchronously at the commit, together with an admission reservation watch.
 * Empty visible inventories are not settlement proof: unavailable owner reads remain explicit
 * blockers rather than optimistic idle.
 */
export async function probeSessionPromotionQuiescence(
  params: SessionPromotionProbeParams & {
    /** Extends the caller's admission reservation watch to descendants in other stores. */
    watch?: { add: (scope: string, identities: Iterable<string | undefined>) => void };
  },
): Promise<SessionPromotionQuiescence> {
  const collector = createCollector();
  const { add } = collector;
  const roots = new Set([params.sessionKey, ...params.sessionKeys]);
  const targets = new Map<string, ProbeTarget>();
  for (const key of roots) {
    targets.set(key, { sessionId: params.sessionId, agentId: params.agentId });
  }

  try {
    await withSubagentRunReadSnapshot(
      subagentRuns,
      (rows) => ({ runIds: relevantRuns(roots, rows).map(([id]) => id), sessionKeys: [...roots] }),
      (_selection, rows) => {
        for (const [, row] of relevantRuns(roots, rows)) {
          if (!roots.has(row.childSessionKey)) {
            targets.set(row.childSessionKey, {
              sessionId: row.childSessionIdentity?.sessionId,
              agentId: row.childAgentId ?? params.agentId,
            });
          }
          inspectDelegationRow(add, row);
        }
      },
      { sessionKeys: [...roots], descendants: true },
    );
  } catch {
    add("inventory-unavailable", "subagent-registry");
  }
  for (const [sessionKey, target] of targets) {
    if (roots.has(sessionKey)) {
      continue;
    }
    const store = collector.read("session-work-admissions", () =>
      resolveSessionEntryAccessTarget(
        { cfg: params.context.getRuntimeConfig(), agentId: target.agentId, sessionKey },
        { keyFormat: "agent-qualified" },
      ),
    );
    target.storePath = store?.storePath;
    target.aliases = store
      ? [store.canonicalKey, store.storeKey, ...store.storeKeys].filter(Boolean)
      : undefined;
    if (target.storePath) {
      params.watch?.add(target.storePath, [
        ...new Set([sessionKey, target.sessionId, ...(target.aliases ?? [])]),
      ]);
    }
  }

  inspectSynchronousOwners(params, roots, targets, collector, { liveDelegations: false });

  // Worker result reads are asynchronous; only the authoritative probe makes them.
  if (!params.quick) {
    const placements = params.context.workerSessionPlacementService;
    for (const [sessionKey, { sessionId }] of targets) {
      if (!sessionId) {
        continue;
      }
      if (!placements) {
        // No readable placement owner is not proof that no workspace result is pending.
        add("worker-result-inventory-unavailable", "worker-placement", sessionKey);
        continue;
      }
      try {
        if (!placements.listPendingWorkspaceResultsAsync) {
          add("worker-result-inventory-unavailable", "worker-placement", sessionKey);
        } else if ((await placements.listPendingWorkspaceResultsAsync(sessionId)).length) {
          add("worker-result", "worker-placement", sessionKey);
        }
        if (!placements.getWorkspaceResultReconcilingSessionIdsAsync) {
          add("worker-reconciliation-inventory-unavailable", "worker-placement", sessionKey);
        } else if (
          (await placements.getWorkspaceResultReconcilingSessionIdsAsync([sessionId])).has(
            sessionId,
          )
        ) {
          add("worker-reconciliation", "worker-placement", sessionKey);
        }
      } catch {
        add("inventory-unavailable", "worker-placement", sessionKey);
      }
    }
  }
  return {
    blockers: collector.blockers,
    recheck: () => {
      const again = createCollector();
      inspectSynchronousOwners(params, roots, targets, again, { liveDelegations: true });
      return again.blockers;
    },
  };
}
