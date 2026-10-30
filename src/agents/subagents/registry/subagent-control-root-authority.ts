/** Worker-backed proof that a detached session root is no longer a former parent's child. */
import { cloneEnvWithPlatformSemantics } from "../../../config/config-env-vars.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { prepareSessionGenerationFacts } from "../../../config/sessions/session-delivery-generation.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";

export const PROMOTED_ROOT_FORMER_PARENT_DENIED =
  "Promoted session is no longer owned by its former parent.";
export const UNPROVED_ROOT_CONTROL_DENIED =
  "Session ownership could not be proved; former-parent control is refused.";

export type ChildRootAuthorization =
  | { proved: false }
  | { proved: true; missing: true }
  | {
      proved: true;
      missing: false;
      promotedFrom: SessionEntry["promotedFrom"];
      sessionId: string | null;
      lifecycleRevision: string | null;
    };

/** Revocable child identity held across awaits. Publication must call assertCurrent. */
export type RetainedChildRootProof = {
  facts: ChildRootAuthorization;
  assertCurrent: () => ChildRootAuthorization;
  prepareRead: () => Promise<void> | undefined;
  release: () => void;
};

type RootEdge = Pick<
  SubagentRunReadRecord,
  "requesterSessionKey" | "childSessionKey" | "childHandoff"
>;

type ChildRootTarget = Pick<SubagentRunReadRecord, "childSessionKey" | "childAgentId">;

export function isFormerParentSpawnerEdge(
  entry: Pick<SubagentRunReadRecord, "requesterSessionKey" | "childSessionKey">,
): boolean {
  return entry.requesterSessionKey.trim() !== entry.childSessionKey.trim();
}

/**
 * Deny former-parent control of a committed detached root.
 * A registry childHandoff marker stays on the existing ownership checks.
 * A missing row is proved absence, not a detached root.
 */
export function detachedRootAuthorizationError(
  entry: RootEdge,
  facts: ChildRootAuthorization,
): string | undefined {
  if (entry.childHandoff) {
    return undefined;
  }
  if (!facts.proved) {
    return UNPROVED_ROOT_CONTROL_DENIED;
  }
  if (facts.missing) {
    return undefined;
  }
  if (facts.promotedFrom !== undefined && isFormerParentSpawnerEdge(entry)) {
    return PROMOTED_ROOT_FORMER_PARENT_DENIED;
  }
  return undefined;
}

function factsFromEntry(entry: SessionEntry | undefined): ChildRootAuthorization {
  if (!entry) {
    return { proved: true, missing: true };
  }
  return {
    proved: true,
    missing: false,
    promotedFrom: entry.promotedFrom,
    sessionId: entry.sessionId ?? null,
    lifecycleRevision: entry.lifecycleRevision ?? null,
  };
}

/** Read the child session row. Unknown worker outcomes stay terminal; other failures are unproved. */
export async function readChildRootAuthorization(
  cfg: OpenClawConfig,
  entry: ChildRootTarget,
  assertCurrent: () => void = () => {},
): Promise<ChildRootAuthorization> {
  const owner = resolveSubagentChildSessionOwner(entry, cfg);
  const env = cloneEnvWithPlatformSemantics(process.env);
  try {
    return await withSessionEntryReadOnlyInWorker(
      {
        storePath: owner.storePath,
        sessionKey: entry.childSessionKey,
        agentId: owner.agentId,
        env,
      },
      assertCurrent,
      async (read) => {
        if (!read.ok) {
          return { proved: false };
        }
        return factsFromEntry(read.value);
      },
    );
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return { proved: false };
  }
}

function readFreshChildRootFacts(
  owner: { agentId: string; storePath: string },
  sessionKey: string,
): ChildRootAuthorization {
  try {
    return factsFromEntry(
      loadExactSessionEntryReadOnly({
        storePath: owner.storePath,
        sessionKey,
        agentId: owner.agentId,
      })?.entry,
    );
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return { proved: false };
  }
}

/**
 * Hold the child incarnation across later awaits.
 * assertCurrent re-reads promotedFrom and fails if sessionId or lifecycleRevision moved.
 */
export async function retainChildRootProof(
  cfg: OpenClawConfig,
  entry: ChildRootTarget,
  assertCaller: () => void = () => {},
): Promise<RetainedChildRootProof> {
  const owner = resolveSubagentChildSessionOwner(entry, cfg);
  const initial = await readChildRootAuthorization(cfg, entry, assertCaller);
  let assertLease = () => {};
  let releaseLease = () => {};
  let prepareLease: () => Promise<void> | undefined = () => undefined;
  let released = false;
  if (initial.proved && !initial.missing && initial.sessionId) {
    try {
      const lease = await prepareSessionGenerationFacts({
        agentId: owner.agentId,
        storePath: owner.storePath,
        sessionKey: entry.childSessionKey,
        sessionId: initial.sessionId,
        lifecycleRevision: initial.lifecycleRevision,
        env: cloneEnvWithPlatformSemantics(process.env),
      });
      assertLease = () => {
        lease.assertCurrent();
      };
      releaseLease = () => {
        lease.release();
      };
      prepareLease = lease.prepareRead;
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      const failure = error;
      assertLease = () => {
        throw failure;
      };
    }
  }
  const leased =
    initial.proved && !initial.missing && initial.sessionId
      ? { sessionId: initial.sessionId, lifecycleRevision: initial.lifecycleRevision }
      : undefined;
  return {
    facts: initial,
    assertCurrent: () => {
      if (released) throw new Error("Child root proof has been released.");
      assertLease();
      const facts = readFreshChildRootFacts(owner, entry.childSessionKey);
      if (!leased) {
        return initial.proved && initial.missing && facts.proved && facts.missing
          ? facts
          : { proved: false };
      }
      if (
        leased &&
        (!facts.proved ||
          facts.missing ||
          facts.sessionId !== leased.sessionId ||
          facts.lifecycleRevision !== leased.lifecycleRevision)
      ) {
        throw new Error("Child root incarnation changed before publication.");
      }
      return facts;
    },
    prepareRead: () => {
      if (released) throw new Error("Child root proof has been released.");
      return prepareLease();
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;
      releaseLease();
    },
  };
}

export type SyncOnly<R> = R extends PromiseLike<unknown> ? [never] : [];
export type ChildRootReadLease<T extends ChildRootTarget & RootEdge & { runId: string }> = {
  readonly candidates: readonly T[];
  prepareRead(): Promise<void> | undefined;
  commitSync<R>(
    accept: (entry: T, facts: ChildRootAuthorization) => boolean,
    render: (accepted: readonly T[]) => R,
    ...forbidPromise: SyncOnly<R>
  ): R;
  assertTargetCurrentSync(runId: string): void;
  release(): void;
};

/** Owns proofs across helper return until the caller materializes its snapshot. */
export async function selectEntriesWithCurrentChildRoot<
  T extends ChildRootTarget & RootEdge & { runId: string },
>(
  cfg: OpenClawConfig,
  entries: readonly T[],
  assertCaller: () => void = () => {},
): Promise<ChildRootReadLease<T>> {
  const held: Array<{ entry: T; proof: RetainedChildRootProof }> = [];
  let transferred = false;
  try {
    for (const entry of entries) {
      held.push({ entry, proof: await retainChildRootProof(cfg, entry, assertCaller) });
    }
    let released = false;
    const assertActive = () => {
      if (released) throw new Error("Child root selection has been released.");
      assertCaller();
    };
    const current = (item: (typeof held)[number]) => {
      try {
        return item.proof.assertCurrent();
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) throw error;
        return undefined;
      }
    };
    const lease: ChildRootReadLease<T> = {
      candidates: entries,
      prepareRead: () => {
        assertActive();
        const pending = held.flatMap(({ proof }) => proof.prepareRead() ?? []);
        return pending.length ? Promise.all(pending).then(() => {}) : undefined;
      },
      commitSync: <R>(
        accept: (entry: T, facts: ChildRootAuthorization) => boolean,
        render: (accepted: readonly T[]) => R,
        ..._forbidPromise: SyncOnly<R>
      ) => {
        assertActive();
        const accepted = held.flatMap((item) => {
          const facts = current(item);
          return facts && accept(item.entry, facts) ? [item.entry] : [];
        });
        const result = render(accepted);
        if (
          result != null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          throw new TypeError("Child root snapshot renderer must be synchronous.");
        }
        return result;
      },
      assertTargetCurrentSync: (runId) => {
        assertActive();
        const item = held.find(({ entry }) => entry.runId === runId);
        const facts = item && current(item);
        if (
          !facts ||
          !facts.proved ||
          facts.missing ||
          !item ||
          item.entry.childHandoff ||
          detachedRootAuthorizationError(item.entry, facts)
        ) {
          throw new Error("Subagent target is no longer authorized.");
        }
      },
      release: () => {
        if (released) return;
        released = true;
        for (const item of held) item.proof.release();
      },
    };
    transferred = true;
    return lease;
  } finally {
    if (!transferred) for (const item of held) item.proof.release();
  }
}
