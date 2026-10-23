import { isSubagentRunLifecycleSettled } from "./subagent-delivery-state.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** A run in which another session (its spawner or a steering requester) owned this child. */
function isSpawnerEdge(entry: SubagentRunRecord, childSessionKey: string): boolean {
  return (
    entry.childSessionKey.trim() === childSessionKey &&
    entry.requesterSessionKey.trim() !== childSessionKey &&
    !entry.childHandoff
  );
}

/**
 * Marks every settled spawner-side run of a promoted child as handed off, so its former requester
 * stops treating the child as part of its subtree. Rows keep all their history. A run that still
 * owes an effect is left alone and reported; activation only commits once all of them settled,
 * and the next pass marks any it skipped. Idempotent.
 */
export async function markSubagentChildHandedOff(params: {
  runs: Map<string, SubagentRunRecord>;
  childSessionKey: string;
  childSessionId?: string;
  at?: number;
}): Promise<{ marked: number; unsettled: number }> {
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    return { marked: 0, unsettled: 0 };
  }
  const candidates = [...params.runs.values()].filter((entry) =>
    isSpawnerEdge(entry, childSessionKey),
  );
  const settled = candidates.filter(isSubagentRunLifecycleSettled);
  const unsettled = candidates.length - settled.length;
  if (settled.length === 0) {
    return { marked: 0, unsettled };
  }
  const at = params.at ?? Date.now();
  const marked = await mutateSubagentRuns(
    settled.map((entry) => entry.runId),
    (rows) => {
      const postimages = new Map<string, SubagentRunRecord>();
      for (const [runId, row] of rows) {
        if (isSpawnerEdge(row, childSessionKey) && isSubagentRunLifecycleSettled(row)) {
          postimages.set(runId, {
            ...row,
            childHandoff: {
              kind: "session-promoted",
              at,
              ...(params.childSessionId ? { childSessionId: params.childSessionId } : {}),
            },
          });
        }
      }
      return { value: postimages.size, postimages };
    },
    { runs: params.runs },
  );
  return { marked, unsettled: unsettled + (settled.length - marked) };
}

type ChildRootFacts = {
  spawnedBy?: string;
  spawnDepth?: number;
  createdVia?: string;
  promotedFrom?: unknown;
};

/**
 * Whether a registry run still names the child session's controller. A handed-off row never
 * does. A session row that records a root (created by an operator, or promoted) with no spawn
 * lineage is owned by a registry run only while that run executes: a settled initial-task run
 * does not make an operator-created or promoted root its requester's child.
 */
export function subagentRunOwnsChildSession(
  run: Pick<SubagentRunReadRecord, "childHandoff" | "execution"> | null | undefined,
  entry?: ChildRootFacts,
): boolean {
  if (!run || run.childHandoff) {
    return false;
  }
  if (!entry || typeof run.execution.endedAt !== "number") {
    return true;
  }
  const delegated =
    (typeof entry.spawnedBy === "string" && entry.spawnedBy.trim() !== "") ||
    (entry.spawnDepth ?? 0) > 0;
  return delegated || (entry.createdVia !== "operator" && entry.promotedFrom === undefined);
}
