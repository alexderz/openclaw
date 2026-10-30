/** Only recorded, internally consistent incarnation facts authorize run-owned cancellation. */
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function resolveRunOwnedKillTarget(run: Pick<SubagentRunRecord, "childSessionKey" | "childSessionIdentity" | "execution">) {
  const target = run.execution.transcriptTarget;
  if (target && target.sessionKey !== run.childSessionKey) {
    throw new Error("Subagent cancellation target key changed.");
  }
  const identity = run.childSessionIdentity;
  const completeIdentity = identity?.sessionId && identity.lifecycleRevision
    ? { sessionId: identity.sessionId, revision: identity.lifecycleRevision }
    : undefined;
  const completeTarget = target?.sessionId && target.expectedLifecycleRevision
    ? { sessionId: target.sessionId, revision: target.expectedLifecycleRevision }
    : undefined;
  if (identity && target &&
      ((identity.sessionId && target.sessionId && identity.sessionId !== target.sessionId) ||
       (identity.lifecycleRevision && target.expectedLifecycleRevision &&
        identity.lifecycleRevision !== target.expectedLifecycleRevision))) {
    throw new Error("Subagent cancellation incarnation records disagree.");
  }
  const recorded = completeIdentity ?? completeTarget;
  return recorded ? {
    ...target,
    sessionKey: run.childSessionKey,
    sessionId: recorded.sessionId,
    expectedLifecycleRevision: recorded.revision,
  } : undefined;
}
