/** Exact parent-owned paused-task binding for explicit model-tool resume admission. */
import {
  detachedRootAuthorizationError,
  retainChildRootProof,
  UNPROVED_ROOT_CONTROL_DENIED,
  type ChildRootAuthorization,
} from "../agents/subagents/registry/subagent-control-root-authority.js";
import {
  ensureSubagentControllerOwnsRun,
  resolveSubagentController,
} from "../agents/subagents/registry/subagent-control-scope.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import type { TrustedSubagentResume } from "./in-process-subagent-resume.js";
import type { GatewayContextResolver, TrustedAgentToolCaller } from "./server-methods/types.js";

/** Select task continuation from recorded ownership; admission still binds and revalidates it. */
export function shouldResumeParentSubagent(params: {
  cfg: OpenClawConfig;
  caller: TrustedAgentToolCaller;
  childSessionKey: string;
  rootFacts?: ChildRootAuthorization;
}): boolean {
  const entry = getLatestLiveSubagentRunByChildSessionKey(
    params.childSessionKey,
    (candidate) => candidate.pauseReason === "sessions_yield",
  );
  if (!entry || entry.expectsCompletionMessage !== true) {
    return false;
  }
  const controllerStorePath = entry.controllerSessionKey?.trim()
    ? entry.controllerStorePath
    : entry.requesterStorePath;
  if (controllerStorePath === undefined) {
    return false;
  }
  // Omitted facts are not authority. Callers pass a current child-root proof.
  if (!params.rootFacts) {
    return false;
  }
  const controller = resolveSubagentController({
    cfg: params.cfg,
    agentId: params.caller.agentId,
    agentSessionKey: params.caller.sessionKey,
  });
  return (
    controller.controlScope === "children" &&
    ensureSubagentControllerOwnsRun({
      cfg: params.cfg,
      controller,
      entry,
      rootFacts: params.rootFacts,
    }) === undefined
  );
}

/** Re-reads and asserts the child root before implicit resume so a missing handoff fails closed. */
export async function shouldResumeParentSubagentNow(
  params: Parameters<typeof shouldResumeParentSubagent>[0],
): Promise<boolean> {
  const entry = getLatestLiveSubagentRunByChildSessionKey(
    params.childSessionKey,
    (candidate) => candidate.pauseReason === "sessions_yield",
  );
  if (!entry) {
    return false;
  }
  const proof = await retainChildRootProof(params.cfg, entry, () => {
    params.caller.assertCurrent?.();
  });
  try {
    const rootFacts = proof.assertCurrent();
    return shouldResumeParentSubagent({ ...params, rootFacts });
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return false;
  } finally {
    proof.release();
  }
}

// Control ownership comes from the registry, not the child's key shape or message provenance.
function requirePausedChild(
  cfg: OpenClawConfig,
  caller: TrustedAgentToolCaller,
  key: string,
  rootFacts?: ChildRootAuthorization,
) {
  if (!caller.assertCurrent) {
    throw new Error("Task resume requires an admitted parent tool caller.");
  }
  caller.assertCurrent();
  const controller = resolveSubagentController({
    cfg,
    agentId: caller.agentId,
    agentSessionKey: caller.sessionKey,
  });
  const entry = getLatestLiveSubagentRunByChildSessionKey(
    key,
    (candidate) => candidate.pauseReason === "sessions_yield",
  );
  if (
    !entry ||
    typeof entry.execution.endedAt !== "number" ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.terminalOwner ||
    entry.suppressAnnounceReason ||
    entry.cleanupCompletedAt !== undefined ||
    entry.execution.suppressSessionEffects
  ) {
    throw new Error(
      "Task resume requires a currently paused native child; inspect subagents first.",
    );
  }
  if (!rootFacts) {
    throw new Error(UNPROVED_ROOT_CONTROL_DENIED);
  }
  const detachedRootError = detachedRootAuthorizationError(entry, rootFacts);
  if (detachedRootError) {
    throw new Error(detachedRootError);
  }
  if (
    controller.controlScope !== "children" ||
    ensureSubagentControllerOwnsRun({ cfg, controller, entry, rootFacts })
  ) {
    throw new Error("Task resume is limited to children controlled by the calling session.");
  }
  if (entry.expectsCompletionMessage === false) {
    throw new Error("Task resume requires a child with task-owned completion.");
  }
  return entry;
}

/** Captures the exact paused generation and a revocable child-root proof. */
export async function bindParentSubagentResume(params: {
  cfg: OpenClawConfig;
  caller: TrustedAgentToolCaller;
  childSessionKey: string;
  childSessionId: string;
}): Promise<TrustedSubagentResume> {
  if (!params.childSessionId) {
    throw new Error("Task resume requires an existing child session.");
  }
  const proof = await retainChildRootProof(
    params.cfg,
    { childSessionKey: params.childSessionKey },
    () => {
      params.caller.assertCurrent?.();
    },
  );
  try {
    const entry = requirePausedChild(
      params.cfg,
      params.caller,
      params.childSessionKey,
      proof.assertCurrent(),
    );
    return Object.freeze({
      caller: params.caller,
      childSessionKey: params.childSessionKey,
      childSessionId: params.childSessionId,
      previousRunId: entry.runId,
      taskRunId: entry.taskRunId ?? entry.runId,
      generation: entry.generation,
      createdAt: entry.createdAt,
      assertChildRootCurrent: () => proof.assertCurrent(),
      releaseChildRootProof: () => {
        proof.release();
      },
    });
  } catch (error) {
    proof.release();
    throw error;
  }
}

/** Revalidates caller ownership and the retained child root at admission. */
export function assertParentSubagentResumeCurrent(params: {
  cfg: OpenClawConfig;
  resume: TrustedSubagentResume;
  sessionKey: string | undefined;
  sessionId: string;
}): SubagentRunRecord {
  const { resume } = params;
  const rootFacts = resume.assertChildRootCurrent();
  const entry = requirePausedChild(
    params.cfg,
    resume.caller,
    resume.childSessionKey,
    rootFacts,
  );
  if (
    params.sessionKey !== resume.childSessionKey ||
    params.sessionId !== resume.childSessionId ||
    entry.runId !== resume.previousRunId ||
    (entry.taskRunId ?? entry.runId) !== resume.taskRunId ||
    entry.generation !== resume.generation ||
    entry.createdAt !== resume.createdAt ||
    (entry.execution.transcriptTarget?.sessionId !== undefined &&
      entry.execution.transcriptTarget.sessionId !== resume.childSessionId)
  ) {
    throw new Error("Paused task or child session changed before resume; inspect subagents again.");
  }
  return entry;
}

/** Fences queued execution after the paused task transfers away from its parent caller. */
export function assertParentSubagentResumeSuccessorCurrent(
  resume: TrustedSubagentResume,
  runId: string,
): void {
  const current = getLatestLiveSubagentRunByChildSessionKey(resume.childSessionKey);
  if (
    !current ||
    current.runId !== runId ||
    current.taskRunId !== resume.taskRunId ||
    current.pauseReason ||
    current.killIntent ||
    current.killReconciliation ||
    typeof current.execution.endedAt === "number"
  ) {
    throw new Error("Resumed task no longer owns this execution.");
  }
}

/** Loads the replacement owner; final admission awaits its durable ownership transfer. */
export async function prepareParentSubagentResume(params: {
  cfg: OpenClawConfig;
  resume: TrustedSubagentResume;
  sessionKey: string | undefined;
  getSessionId: () => string;
  runId: string;
  task: string;
  assertAdmissionCurrent: () => void;
  onAdopted?: (entry: SubagentRunRecord) => void;
  gatewayContextResolver?: GatewayContextResolver;
}): Promise<() => Promise<string>> {
  const runtime = await import("../agents/subagents/registry/subagent-registry.js");
  return async () => {
    params.assertAdmissionCurrent();
    const expected = assertParentSubagentResumeCurrent({
      ...params,
      sessionId: params.getSessionId(),
    });
    const adopted = await runtime.adoptPausedSubagentRunForFollowUp({
      childSessionKey: params.resume.childSessionKey,
      runId: params.runId,
      task: params.task,
      expected,
      onPublished: params.onAdopted,
      gatewayContextResolver: params.gatewayContextResolver,
      assertCurrent: () => {
        params.assertAdmissionCurrent();
        assertParentSubagentResumeCurrent({
          ...params,
          sessionId: params.getSessionId(),
        });
      },
    });
    if (!adopted) {
      throw new Error("Paused task replacement was rejected; no continuation was started.");
    }
    assertParentSubagentResumeSuccessorCurrent(params.resume, params.runId);
    return params.resume.taskRunId;
  };
}
