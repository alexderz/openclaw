import { z } from "zod";
import { getSubagentDepth, isAcpSessionKey } from "./session-key-utils.js";

/**
 * A completed promotion turns a delegated session into a root, exactly like a dashboard session
 * a human created directly. What it was spawned from is kept here as history only: nothing reads
 * this record for authority, policy, routing, depth or nesting.
 */
const boundedId = z.string().min(1).max(128);
const promotedFromSchema = z.strictObject({
  version: z.literal(1),
  requestId: boundedId,
  /** The human whose promotion detached the session. */
  profileId: boundedId,
  /** When the promotion activated. */
  at: z.number().finite().nonnegative(),
  parentSessionKey: z.string().min(1).max(2048).optional(),
  parentSessionId: boundedId.optional(),
  spawnDepth: z.number().int().nonnegative().optional(),
});
export type SessionPromotedFrom = z.infer<typeof promotedFromSchema>;

export function decodeSessionPromotedFrom(value: unknown): SessionPromotedFrom | undefined {
  try {
    const result = promotedFromSchema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Only a key whose shape is not delegated by itself can become indistinguishable from a
 * dashboard root. `:subagent:` keys are delegated by key shape throughout the runtime, and ACP
 * keys run an external harness; their activated promotions keep the direct-turn scope.
 */
export function canDetachPromotedSessionKey(key: string): boolean {
  return getSubagentDepth(key) === 0 && !isAcpSessionKey(key);
}

/** Fields that bind a session to its spawner: authority, policy, completion routing and depth. */
const DELEGATION_FIELDS = [
  "spawnedBy",
  "spawnedBySenderIsOwner",
  "spawnedBySessionId",
  "completionOwnerSessionKey",
  "parentSessionId",
  "parentSessionLifecycleRevision",
  "subagentRole",
  "subagentControlScope",
  "inheritedToolPolicyVersion",
  "inheritedToolPolicySource",
  "inheritedToolDeny",
  "inheritedToolAllow",
] as const;

type DetachableEntry = {
  [K in (typeof DELEGATION_FIELDS)[number]]?: unknown;
} & {
  spawnDepth?: number;
  parentSessionKey?: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
  promotedFrom?: SessionPromotedFrom;
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** True while any spawn lineage that a dashboard root never has is still on the row. */
export function hasDelegationLineage(entry: DetachableEntry): boolean {
  return (
    (entry.spawnDepth ?? 0) > 0 ||
    DELEGATION_FIELDS.some((field) => entry[field] !== undefined && entry[field] !== null)
  );
}

/** A completed, detached promotion: a plain root that keeps its history. */
export function isDetachedPromotedSession(entry: DetachableEntry): boolean {
  return (
    decodeSessionPromotedFrom(entry.promotedFrom) !== undefined && !hasDelegationLineage(entry)
  );
}

/**
 * Rewrites an activated delegated row into a dashboard root, in place, inside the same store
 * write as the activation (or as the completion of an older activation). Idempotent: a row that
 * no longer carries delegation lineage is left untouched and `false` is returned.
 *
 * - Depth 0 and no spawner: every turn resolves as a never-delegated session, new spawns count
 *   from 0, completions and approvals no longer route to the former parent.
 * - The parent link becomes the agent's main root when the caller supplies it (what a dashboard
 *   session a human creates gets), otherwise it is removed.
 * - The workspace a later turn re-enters stays the one it used before: a spawner-inherited
 *   workspace is kept as the session's own cwd.
 * - Sandbox, worktree, owner, creator and model settings are not touched; nothing is widened.
 */
export function detachPromotedSessionEntry(params: {
  entry: DetachableEntry;
  key: string;
  promotion: { requestId: string; profileId: string; activatedAt: number };
  /** The agent's main root for a dashboard-shaped key, as session creation would assign it. */
  rootParentSessionKey?: string;
}): boolean {
  const { entry } = params;
  if (!canDetachPromotedSessionKey(params.key) || !hasDelegationLineage(entry)) {
    return false;
  }
  const spawnedBy = text(entry.spawnedBy);
  const inheritedWorkspace = spawnedBy ? text(entry.spawnedWorkspaceDir) : undefined;
  if (!decodeSessionPromotedFrom(entry.promotedFrom)) {
    const parentSessionKey = spawnedBy ?? text(entry.parentSessionKey);
    const parentSessionId = text(entry.spawnedBySessionId) ?? text(entry.parentSessionId);
    const depth = entry.spawnDepth;
    entry.promotedFrom = {
      version: 1,
      requestId: params.promotion.requestId,
      profileId: params.promotion.profileId,
      at: params.promotion.activatedAt,
      ...(parentSessionKey ? { parentSessionKey } : {}),
      ...(parentSessionId && parentSessionId.length <= 128 ? { parentSessionId } : {}),
      ...(typeof depth === "number" && Number.isInteger(depth) && depth > 0
        ? { spawnDepth: depth }
        : {}),
    };
  }
  for (const field of DELEGATION_FIELDS) {
    delete entry[field];
  }
  // Session creation persists every non-spawned root at an explicit depth 0.
  entry.spawnDepth = 0;
  const root = text(params.rootParentSessionKey);
  if (root && root !== params.key) {
    entry.parentSessionKey = root;
  } else {
    delete entry.parentSessionKey;
  }
  if (inheritedWorkspace && !text(entry.spawnedCwd)) {
    entry.spawnedCwd = inheritedWorkspace;
  }
  return true;
}
