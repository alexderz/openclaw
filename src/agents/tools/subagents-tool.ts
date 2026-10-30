import { AsyncLocalStorage } from "node:async_hooks";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { sanitizeRunStatusText } from "../run-status-text.js";
import { optionalPositiveIntegerSchema, optionalStringEnum } from "../schema/typebox.js";
import {
  detachedRootAuthorizationError,
  retainChildRootProof,
  type RetainedChildRootProof,
  type SyncOnly,
} from "../subagents/registry/subagent-control-root-authority.js";
import {
  ensureSubagentControllerOwnsRun,
  isSubagentRunVisibleToSession,
  listControlledSubagentRunFacts,
  resolveSubagentControllerIdentity,
} from "../subagents/registry/subagent-control-scope.js";
import {
  DEFAULT_RECENT_MINUTES,
  killSubagentRunAdmin,
  buildControlledSubagentRunsReadContext,
  MAX_RECENT_MINUTES,
  resolveSubagentController,
} from "../subagents/registry/subagent-control.js";
import type { ResolvedSubagentController } from "../subagents/registry/subagent-control.types.js";
import { createSubagentControllerRead } from "../subagents/registry/subagent-controller-read.js";
import { observeSubagentExecution } from "../subagents/registry/subagent-execution-observation.js";
import {
  buildSubagentList,
  readSubagentListSessionEntries,
} from "../subagents/registry/subagent-list.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "../subagents/registry/subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "../subagents/registry/subagent-registry-publication.js";
import type { SubagentRunReadRecord } from "../subagents/registry/subagent-registry-read.types.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentRunsSnapshotForRunIds,
  prepareSubagentSessionListReadCache,
} from "../subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { isSameSubagentRunOwner } from "../subagents/registry/subagent-run-generation.js";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";

const SUBAGENT_ACTIONS = ["list", "wait", "cancel"] as const;
const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  recentMinutes: optionalPositiveIntegerSchema(),
  runId: Type.Optional(Type.String()),
  runIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 })),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 60,
      description: "Wait duration in integer seconds, 0–60 (default: 30). Use 0 for a snapshot.",
    }),
  ),
});
type SubagentsToolOptions = {
  agentSessionKey?: string;
  callerPolicySessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
};
function mapRun(run: SubagentRunRecord) {
  return {
    runId: run.runId,
    sessionKey: run.childSessionKey,
    label: sanitizeRunStatusText(run.label, { maxChars: 80 }) || undefined,
    status: run.pauseReason === "sessions_yield" ? "waiting" : run.execution.status,
    outcome: run.execution.outcome
      ? {
          status: run.execution.outcome.status,
          error:
            sanitizeRunStatusText(run.execution.outcome.error, {
              errorContext: true,
              maxChars: 120,
            }) || undefined,
        }
      : undefined,
    deliveryStatus: run.delivery?.status,
    startedAt: run.execution.startedAt,
    endedAt: run.execution.endedAt,
  };
}
function waitForSelectedRuns(params: {
  runIds: string[];
  readRuns: (snapshot: ReadonlyMap<string, SubagentRunRecord>) => SubagentRunRecord[];
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  // A publisher's temporary scope must not own preparation started by its wake.
  const inWaitContext = AsyncLocalStorage.snapshot();
  const read = (snapshot: ReadonlyMap<string, SubagentRunRecord>) => {
    const visible = new Map(params.readRuns(snapshot).map((task) => [task.runId, task]));
    const tasks = params.runIds.flatMap((runId) => {
      const task = visible.get(runId);
      return task ? [task] : [];
    });
    const unavailable = params.runIds.filter((runId) => !visible.has(runId));
    const attention = tasks.filter((task) => {
      const wait = observeSubagentExecution(task, []).wait;
      return task.delivery?.status === "suspended" || wait?.kind === "external";
    });
    const completed = tasks.filter(
      (task) => task.execution.status === "terminal" && task.pauseReason !== "sessions_yield",
    );
    return {
      reason: unavailable.length
        ? "unavailable"
        : attention.length
          ? "attention"
          : completed.length
            ? "completed"
            : undefined,
      runs: tasks.map(mapRun),
      completed: completed.map((task) => task.runId),
      attention: attention.map((task) => task.runId),
      ...(unavailable.length ? { unavailable } : {}),
    };
  };
  return new Promise<ReturnType<typeof read>>((resolve, reject) => {
    let settled = false;
    let preparation: Promise<void> | undefined;
    let prepared: Awaited<ReturnType<typeof prepareSubagentRunsSnapshotForRunIds>> | undefined;
    let timedOut = params.timeoutMs === 0;
    let abortError: Error | undefined;
    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
    };
    const finish = () =>
      inWaitContext(() => {
        if (settled || preparation) {
          return;
        }
        try {
          const compactReady = getSubagentSessionListReadSnapshotIdentity();
          // Another reader's accepted recovery also keeps custody through abort.
          if (!compactReady || !prepared) {
            preparation = !compactReady
              ? prepareSubagentSessionListReadCache()
              : prepareSubagentRunsSnapshotForRunIds(subagentRuns, params.runIds).then(
                  (snapshot) => {
                    prepared = snapshot;
                  },
                );
            void preparation.then(
              () => {
                preparation = undefined;
                finish();
              },
              (error: unknown) => {
                preparation = undefined;
                fail(error);
              },
            );
            return;
          }
          if (abortError) {
            fail(abortError);
            return;
          }
          const result = prepared.consume(read);
          if (!result.ready) {
            prepared = undefined;
            finish();
            return;
          }
          const state = result.value;
          if (!timedOut && !state.reason) {
            return;
          }
          settled = true;
          cleanup();
          resolve({ ...state, reason: state.reason ?? "timeout" });
        } catch (error) {
          fail(error);
        }
      });
    const onAbort = () => {
      abortError = createAbortError("subagents wait aborted; tasks continue running.");
      // Accepted preparation keeps custody until both the read and cleanup settle.
      finish();
    };
    let wakeQueued = false;
    const wake = () => {
      if (wakeQueued || settled) {
        return;
      }
      wakeQueued = true;
      // The publisher retires its mutation before a reader checks the resulting identity.
      queueMicrotask(() => {
        wakeQueued = false;
        finish();
      });
    };
    const unsubscribe = subscribeSubagentRunChanges("persistence", wake);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, params.timeoutMs);
    if (params.signal?.aborted) {
      onAbort();
    } else {
      // Subscribe before reading so completion cannot be lost between those operations.
      finish();
    }
  });
}

export function createSubagentsTool(opts: SubagentsToolOptions = {}): AnyAgentTool {
  const readScope = async (
    readController?: ReturnType<typeof createSubagentControllerRead>["read"],
  ) => {
    const cfg = opts.config ?? getRuntimeConfig();
    const controller = readController
      ? readController()
      : resolveSubagentController({
          cfg,
          agentSessionKey: opts.agentSessionKey,
          agentId: opts.agentId,
        });
    if (!controller.controllerAgentId) {
      throw new ToolInputError("Subagent controller agent required");
    }
    const readable = new Map<string, SubagentRunReadRecord>();
    const controlled = new Set<string>();
    const held: Array<{ entry: SubagentRunReadRecord; proof: RetainedChildRootProof }> = [];
    const pending: Array<
      Pick<ResolvedSubagentController, "controllerSessionKey" | "controllerAgentId">
    > = [controller];
    const visited = new Set<string>();
    let transferred = false;
    try {
      while (pending.length) {
        const current = pending.shift()!;
        const controllerAgentId = current.controllerAgentId;
        if (!controllerAgentId) {
          throw new ToolInputError("Subagent controller agent required");
        }
        const identity = controllerAgentId + "\0" + current.controllerSessionKey;
        if (visited.has(identity)) {
          continue;
        }
        visited.add(identity);
        const entries = listControlledSubagentRunFacts(
          current.controllerSessionKey,
          controllerAgentId,
          cfg,
        );
        const level: Array<{ entry: SubagentRunReadRecord; proof: RetainedChildRootProof }> = [];
        for (const entry of entries) {
          if (readable.has(entry.runId) || held.some((item) => item.entry.runId === entry.runId)) {
            continue;
          }
          const item = { entry, proof: await retainChildRootProof(cfg, entry) };
          level.push(item);
          held.push(item);
        }
        // Fence this controller's reads before queueing its children, then again before return.
        for (const item of level) {
          let rootFacts;
          try {
            rootFacts = item.proof.assertCurrent();
          } catch (error) {
            if (hasSqliteWorkerOutcomeUnknown(error)) {
              throw error;
            }
            item.proof.release();
            continue;
          }
          if (
            !isSubagentRunVisibleToSession(
              item.entry,
              current.controllerSessionKey,
              controllerAgentId,
              cfg,
              rootFacts,
            )
          ) {
            item.proof.release();
            continue;
          }
          readable.set(item.entry.runId, item.entry);
          if (
            controller.controlScope !== "children" ||
            ensureSubagentControllerOwnsRun({
              cfg,
              controller: current,
              entry: item.entry,
              rootFacts,
            })
          ) {
            continue;
          }
          controlled.add(item.entry.runId);
          pending.push(
            resolveSubagentControllerIdentity({
              cfg,
              agentSessionKey: item.entry.childSessionKey,
              agentId: item.entry.childAgentId,
            }),
          );
        }
      }
      const denied = new Set<string>();
      for (const item of held) {
        if (!readable.has(item.entry.runId)) {
          continue;
        }
        try {
          const rootFacts = item.proof.assertCurrent();
          // Re-prove the child itself. Do not re-apply the top controller's visibility
          // to a descendant discovered under a child controller.
          if (item.entry.childHandoff || detachedRootAuthorizationError(item.entry, rootFacts)) {
            denied.add(item.entry.runId);
          }
        } catch (error) {
          if (hasSqliteWorkerOutcomeUnknown(error)) {
            throw error;
          }
          denied.add(item.entry.runId);
        }
      }
      // A denied ancestor invalidates descendant selections too. Fail closed.
      if (denied.size) {
        throw new Error("Subagent scope changed during preparation.");
      }
      const selected = [...readable.values()];
      let released = false;
      const assertCurrent = () => {
        if (released) throw new Error("Subagent scope has been released.");
        for (const item of held) {
          if (!readable.has(item.entry.runId)) {
            continue;
          }
          const facts = item.proof.assertCurrent();
          if (item.entry.childHandoff || detachedRootAuthorizationError(item.entry, facts)) {
            throw new Error("Subagent scope changed before publication or control.");
          }
        }
      };
      const prepareScopeRead = () => {
        if (released) throw new Error("Subagent scope has been released.");
        const pending = held
          .filter((item) => readable.has(item.entry.runId))
          .flatMap((item) => item.proof.prepareRead() ?? []);
        return pending.length ? Promise.all(pending).then(() => {}) : undefined;
      };
      const commitSync = <R>(render: () => R, ..._forbidPromise: SyncOnly<R>): R => {
        assertCurrent();
        const result = render();
        if (result != null && typeof (result as { then?: unknown }).then === "function")
          throw new TypeError("Scope renderer must be synchronous.");
        return result;
      };
      const release = () => {
        if (released) return;
        released = true;
        for (const item of held) {
          item.proof.release();
        }
      };
      transferred = true;
      return {
        cfg,
        controller,
        readable: selected,
        controlled,
        assertCurrent,
        prepareRead: prepareScopeRead,
        commitSync,
        release,
      };
    } finally {
      if (!transferred) {
        for (const item of held) {
          item.proof.release();
        }
      }
    }
  };
  return {
    label: "Subagents",
    name: "subagents",
    parameters: SubagentsToolSchema,
    description:
      "List native subagents, wait for selected runIds, or cancel a runId and its descendants. A wait timeout never cancels execution or consumes completion delivery.",
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const action = readToolStringParam(params, "action") ?? "list";
      const requestedRunId =
        action === "cancel" ? readToolStringParam(params, "runId", { required: true }) : undefined;
      const source = action === "cancel" ? captureOpenClawStateWorkerContext() : undefined;
      let selection:
        | {
            entry: SubagentRunRecord;
            generation: SubagentRunRecord["generation"];
            createdAt: number;
            ownership: ReturnType<typeof subagentRuns.captureRegistrationOwnership>;
          }
        | undefined;
      const assertSelection = () => {
        if (!source || !requestedRunId) {
          return;
        }
        signal?.throwIfAborted();
        assertSubagentRegistryWriteSourceCurrent(source);
        // A missing live row may still be hydrating. Only the native owner can establish it.
        const entry = subagentRuns.get(requestedRunId);
        if (!selection && entry) {
          selection = {
            entry,
            generation: entry.generation,
            createdAt: entry.createdAt,
            ownership: subagentRuns.captureRegistrationOwnership(
              entry.childSessionKey,
              entry,
              entry.childAgentId,
            ),
          };
        }
        if (selection) {
          selection.ownership.assertCurrent();
          if (
            !entry ||
            !isSameSubagentRunOwner(entry, selection.entry) ||
            entry.generation !== selection.generation ||
            entry.createdAt !== selection.createdAt
          ) {
            throw new Error("Subagent cancellation selection changed during preparation");
          }
        }
      };
      const controllerRead =
        action === "cancel"
          ? createSubagentControllerRead({
              config: () => opts.config ?? getRuntimeConfig(),
              agentSessionKey: opts.agentSessionKey,
              agentId: opts.agentId,
              assertCurrent: assertSelection,
            })
          : undefined;
      let provedScope: Awaited<ReturnType<typeof readScope>> | undefined;
      let cancelProof: RetainedChildRootProof | undefined;
      const readCurrentScope = () => {
        if (!provedScope) {
          throw new Error("Subagent ownership was not proved before control.");
        }
        provedScope.assertCurrent();
        return provedScope;
      };
      const prepareRead = () => {
        assertSelection();
        if (!getSubagentSessionListReadSnapshotIdentity()) {
          return prepareSubagentSessionListReadCache();
        }
        return controllerRead?.prepare();
      };
      try {
        for (let pending = prepareRead(); pending; pending = prepareRead()) {
          await pending;
        }
        signal?.throwIfAborted();
        if (action === "wait") {
          const runIds = [...new Set(readStringArrayParam(params, "runIds", { required: true }))];
          if (runIds.length > 32) {
            throw new ToolInputError("At most 32 runIds may be waited for");
          }
          const proved = await readScope();
          provedScope = proved;
          proved.assertCurrent();
          const proofs = new Map<string, RetainedChildRootProof>();
          try {
            for (const entry of proved.readable) {
              proofs.set(entry.runId, await retainChildRootProof(proved.cfg, entry));
            }
            const waited = await waitForSelectedRuns({
              runIds,
              readRuns: (snapshot) => {
                proved.assertCurrent();
                return [...snapshot.values()].filter((entry) => {
                  const proof = proofs.get(entry.runId);
                  if (!proof || entry.childHandoff) {
                    return false;
                  }
                  try {
                    const facts = proof.assertCurrent();
                    return detachedRootAuthorizationError(entry, facts) === undefined;
                  } catch (error) {
                    if (hasSqliteWorkerOutcomeUnknown(error)) {
                      throw error;
                    }
                    return false;
                  }
                });
              },
              timeoutMs:
                Math.min(60, readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30) * 1000,
              signal,
            });
            for (let pending = proved.prepareRead(); pending; pending = proved.prepareRead())
              await pending;
            return proved.commitSync(() => jsonResult({ status: "ok", action, ...waited }));
          } finally {
            for (const proof of proofs.values()) {
              proof.release();
            }
          }
        }
        provedScope = await readScope(controllerRead?.read);
        const { cfg, controller, readable, controlled } = readCurrentScope();
        if (action === "list") {
          const readContext = await buildControlledSubagentRunsReadContext(
            controller.controllerSessionKey,
            controller.controllerAgentId,
            cfg,
            Math.min(
              MAX_RECENT_MINUTES,
              readPositiveIntegerParam(params, "recentMinutes") ?? DEFAULT_RECENT_MINUTES,
            ),
          );
          try {
            const sessionEntries = await readSubagentListSessionEntries(
              cfg,
              readContext.candidateContext.list,
            );
            for (
              let pending = readContext.prepareRead();
              pending;
              pending = readContext.prepareRead()
            )
              await pending;
            for (
              let pending = provedScope.prepareRead();
              pending;
              pending = provedScope.prepareRead()
            )
              await pending;
            return readContext.commitSync((current) => {
              readCurrentScope();
              const list = buildSubagentList({ context: current.list, sessionEntries });
              return jsonResult({
                status: "ok",
                action,
                requesterSessionKey: controller.controllerSessionKey,
                callerSessionKey: controller.callerSessionKey,
                callerIsSubagent: controller.callerIsSubagent,
                total: list.total,
                active: list.active.map(({ line: _line, ...view }) => view),
                recent: list.recent.map(({ line: _line, ...view }) => view),
                text: list.text,
              });
            });
          } finally {
            readContext.release();
          }
        }
        if (action === "cancel") {
          const runId = requestedRunId;
          if (!runId) {
            throw new ToolInputError("Subagent runId required");
          }
          const target = readable.find((run) => run.runId === runId);
          if (!target || !controlled.has(runId)) {
            return jsonResult({
              status: "forbidden",
              error: "Run outside the controlled session tree.",
            });
          }
          cancelProof = await retainChildRootProof(cfg, target);
          const targetProof = cancelProof;
          const result = await killSubagentRunAdmin(
            {
              cfg,
              sessionKey: target.childSessionKey,
              agentId: target.childAgentId ?? target.requesterAgentId,
              expectedRunId: target.runId,
              expectedTaskRunId: target.taskRunId ?? target.runId,
              expectedGeneration: target.generation,
              expectedOwnerKey: target.requesterSessionKey,
            },
            {
              incarnationAuthority: "run",
              prepareRead: () => {
                const pending = prepareRead();
                if (!pending) {
                  return undefined;
                }
                return pending.then(async () => {
                  const nextScope = await readScope(controllerRead?.read);
                  provedScope?.release();
                  provedScope = nextScope;
                });
              },
              assertCurrent: () => {
                signal?.throwIfAborted();
                let facts;
                try {
                  facts = targetProof.assertCurrent();
                } catch (error) {
                  if (hasSqliteWorkerOutcomeUnknown(error)) {
                    throw error;
                  }
                  throw new Error(
                    "Session ownership could not be proved; former-parent control is refused.",
                  );
                }
                const detached = detachedRootAuthorizationError(target, facts);
                if (target.childHandoff || detached) {
                  throw new Error(
                    detached ??
                      "This session was promoted to a standard session; its former parent no longer controls it.",
                  );
                }
                const current = readCurrentScope();
                if (
                  current.controller.controllerSessionKey !== controller.controllerSessionKey ||
                  current.controller.controllerAgentId !== controller.controllerAgentId ||
                  !current.controlled.has(target.runId) ||
                  !current.readable.some(
                    (run) => run.runId === target.runId && run.generation === target.generation,
                  )
                ) {
                  throw new Error("Subagent cancellation owner changed");
                }
              },
            },
          );
          targetProof.release();
          return jsonResult({ ...result, action, runId });
        }
        throw new ToolInputError("Unsupported subagents action");
      } finally {
        provedScope?.release();
        cancelProof?.release();
        controllerRead?.release();
        selection?.ownership.release();
      }
    },
  };
}
