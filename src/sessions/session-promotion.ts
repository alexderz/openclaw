import { randomUUID } from "node:crypto";
import {
  resolveSessionEntryAccessTarget,
  updateResolvedSessionEntry,
  type LogicalSessionAccessScope,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { promotionAdminBasisAllowed } from "../gateway/session-promotion-ownership.js";
import type { GitHubPublicationRequesterSnapshot } from "../state/github-publication-requester.js";
import { runExclusiveSessionLifecycleMutation } from "./session-lifecycle-admission.js";
import {
  applySessionPromotionRequest,
  activatePendingSessionPromotion as activatePromotionEntry,
  decodeSessionPromotion,
  revokePendingSessionPromotion as revokePromotionEntry,
  SessionPromotionConflictError,
  type SessionPromotion,
} from "./session-promotion-state.js";
import {
  watchSessionWorkAdmissionReservations,
  type SessionWorkAdmissionReservationWatcher,
} from "./session-work-admission-reservation-watch.js";

/** The store reports a replaced incarnation as a plain error; the caller can only retry or refresh. */
const updatePromotionEntry: typeof updateResolvedSessionEntry = async (...args) => {
  try {
    return await updateResolvedSessionEntry(...args);
  } catch (error) {
    throw error instanceof Error && error.message.startsWith("Captured session generation changed")
      ? new SessionPromotionConflictError()
      : error;
  }
};

/**
 * The caller must prepare current human identity/grant/role/own-target/agent facts.
 * No request object, closure or transport token is retained after the store commit.
 */
export async function requestSessionPromotion(params: {
  scope: LogicalSessionAccessScope;
  expectedSessionId: string;
  expectedLifecycleRevision: string;
  requester: GitHubPublicationRequesterSnapshot;
  requestId: string;
  action?: "request" | "cancel";
  device?: { id: string; generation: string };
  now?: number;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<SessionPromotion> {
  params.assertCurrent();
  const target = resolveSessionEntryAccessTarget(params.scope, { keyFormat: "agent-qualified" });
  if (!target.entry) {
    throw new SessionPromotionConflictError();
  }
  return await runExclusiveSessionLifecycleMutation("promote", {
    kind: "promote",
    scope: target.storePath,
    identities: [
      params.scope.sessionKey,
      target.canonicalKey,
      target.storeKey,
      ...target.storeKeys,
      params.expectedSessionId,
    ],
    signal: params.signal,
    run: async () => {
      const result = await updatePromotionEntry(
        params.scope,
        (entry, context) => {
          params.signal?.throwIfAborted();
          params.assertCurrent();
          return applySessionPromotionRequest({
            entry,
            target: {
              agentId: context.agentId,
              key: context.canonicalKey,
              sessionId: params.expectedSessionId,
              fromLifecycleRevision: params.expectedLifecycleRevision,
            },
            requester: params.requester,
            requestId: params.requestId,
            action: params.action,
            ...(params.device ? { device: params.device } : {}),
            now: params.now ?? Date.now(),
            assertCurrent: params.assertCurrent,
            adminBasisAllowed: promotionAdminBasisAllowed({
              profileId:
                params.requester.actor.kind === "operator"
                  ? params.requester.actor.profileId
                  : undefined,
              cfg: params.scope.cfg,
            }),
          });
        },
        {
          target,
          shouldCommit: () => {
            params.signal?.throwIfAborted();
            params.assertCurrent();
            return true;
          },
        },
      );
      const promotion = result.found ? result.entry.sessionPromotion : undefined;
      if (!promotion) {
        throw new SessionPromotionConflictError();
      }
      return promotion;
    },
  });
}

/**
 * Activation is a non-destructive lifecycle boundary, serialized with every work
 * admission. The gateway supplies a restored, currently authorized requester and
 * owner-backed read-only probes. No connection authority is retained here.
 *
 * Ordering: the owner probe may await, so it runs before the lifecycle fence and the store
 * writer; slow owner reads never make delivery generation unavailable or stall other writers.
 * A reservation watch spans the probe, and the fence plus writer cover only synchronous
 * re-checks and the commit. Any admission reserved since the probe started (even one that has
 * already finished) or any synchronous owner that reports work right before the write keeps the
 * intent pending; its release schedules the next attempt.
 */
export async function activatePendingSessionPromotion(params: {
  scope: LogicalSessionAccessScope;
  expectedSessionId: string;
  expectedLifecycleRevision: string;
  requestId?: string;
  basis?: "original-basis" | "fresh-human-rebound";
  now?: number;
  signal?: AbortSignal;
  assertCurrent: () => void;
  /** Owner inventories, outside the fence; `watch` extends ingress detection to other stores. */
  probeBlockers: (
    watch: Pick<SessionWorkAdmissionReservationWatcher, "add">,
  ) => readonly string[] | Promise<readonly string[]>;
  /** Synchronous re-read of the probed owners, on the exact row the commit will rewrite. */
  recheckBlockers?: (entry: InternalSessionEntry) => readonly string[];
}): Promise<{ promotion: SessionPromotion; blockers: readonly string[]; activated: boolean }> {
  params.assertCurrent();
  const target = resolveSessionEntryAccessTarget(params.scope, { keyFormat: "agent-qualified" });
  if (!target.entry) {
    throw new SessionPromotionConflictError();
  }
  const identities = [
    params.scope.sessionKey,
    target.canonicalKey,
    target.storeKey,
    ...target.storeKeys,
    params.expectedSessionId,
  ];
  const watch = watchSessionWorkAdmissionReservations();
  watch.add(target.storePath, identities);
  try {
    const probed = Object.freeze([...new Set(await params.probeBlockers(watch))]);
    params.signal?.throwIfAborted();
    params.assertCurrent();
    const observed = decodeSessionPromotion(target.entry.sessionPromotion);
    if (
      probed.length > 0 &&
      observed?.state === "pending" &&
      (!params.requestId || observed.requestId === params.requestId) &&
      target.entry.sessionId === params.expectedSessionId &&
      observed.target.fromLifecycleRevision === params.expectedLifecycleRevision
    ) {
      // Still busy: neither the fence nor the writer is needed to leave the intent pending.
      return { promotion: observed, blockers: probed, activated: false };
    }
    const recheck = (entry: InternalSessionEntry) => [
      ...probed,
      ...(watch.reserved() ? ["admission-reserved-during-probe"] : []),
      ...(params.recheckBlockers?.(entry) ?? []),
    ];
    return await runExclusiveSessionLifecycleMutation("promote", {
      kind: "promote",
      scope: target.storePath,
      identities,
      signal: params.signal,
      run: async () => {
        let blockers: readonly string[] = [];
        let activated = false;
        // Written by the store callbacks; a holder keeps narrowing honest across them.
        const fenced: { pending?: SessionPromotion; locked?: InternalSessionEntry } = {};
        const result = await updatePromotionEntry(
          params.scope,
          (entry, context) => {
            params.signal?.throwIfAborted();
            params.assertCurrent();
            const promotion = decodeSessionPromotion(entry.sessionPromotion);
            if (
              !promotion ||
              (params.requestId && promotion.requestId !== params.requestId) ||
              entry.sessionId !== params.expectedSessionId ||
              promotion.target.key !== context.canonicalKey ||
              promotion.target.agentId !== context.agentId ||
              promotion.target.fromLifecycleRevision !== params.expectedLifecycleRevision
            ) {
              throw new SessionPromotionConflictError();
            }
            if (promotion.state !== "pending") {
              return;
            }
            fenced.pending = promotion;
            fenced.locked = entry;
            blockers = Object.freeze([...new Set(recheck(entry))]);
            activated = activatePromotionEntry({
              entry,
              target: {
                agentId: context.agentId,
                key: context.canonicalKey,
                sessionId: params.expectedSessionId,
                fromLifecycleRevision: params.expectedLifecycleRevision,
              },
              now: params.now ?? Date.now(),
              nextRevision: randomUUID(),
              blockers,
              ...(params.basis ? { basis: params.basis } : {}),
              assertCurrent: params.assertCurrent,
            });
          },
          {
            target,
            // Runs synchronously inside the write transaction, after the writer's own awaits.
            shouldCommit: () => {
              params.signal?.throwIfAborted();
              params.assertCurrent();
              if (!fenced.locked) {
                return true;
              }
              if (!activated) {
                // A blocked pending intent has nothing to write.
                return false;
              }
              const late = recheck(fenced.locked);
              if (late.length === 0) {
                return true;
              }
              blockers = Object.freeze([...new Set(late)]);
              activated = false;
              return false;
            },
          },
        );
        if (fenced.pending && !activated) {
          // The commit was declined; the row still holds this pending intent.
          return { promotion: fenced.pending, blockers, activated };
        }
        const promotion = decodeSessionPromotion(
          result.found ? result.entry.sessionPromotion : undefined,
        );
        if (!promotion) {
          throw new SessionPromotionConflictError();
        }
        return { promotion, blockers, activated };
      },
    });
  } finally {
    watch.stop();
  }
}

/**
 * Records that the original accepted basis provably ended. Runs under the same lifecycle
 * fence and store writer as activation so it cannot race an admission or an activation.
 */
export async function revokePendingSessionPromotion(params: {
  scope: LogicalSessionAccessScope;
  expectedSessionId: string;
  expectedLifecycleRevision: string;
  requestId: string;
  reason: string;
  now?: number;
  signal?: AbortSignal;
}): Promise<SessionPromotion> {
  const target = resolveSessionEntryAccessTarget(params.scope, { keyFormat: "agent-qualified" });
  if (!target.entry) {
    throw new SessionPromotionConflictError();
  }
  return await runExclusiveSessionLifecycleMutation("promote", {
    kind: "promote",
    scope: target.storePath,
    identities: [
      params.scope.sessionKey,
      target.canonicalKey,
      target.storeKey,
      ...target.storeKeys,
      params.expectedSessionId,
    ],
    signal: params.signal,
    run: async () => {
      const result = await updatePromotionEntry(
        params.scope,
        (entry, context) => {
          params.signal?.throwIfAborted();
          const promotion = decodeSessionPromotion(entry.sessionPromotion);
          if (promotion?.requestId !== params.requestId) {
            throw new SessionPromotionConflictError();
          }
          revokePromotionEntry({
            entry,
            target: {
              agentId: context.agentId,
              key: context.canonicalKey,
              sessionId: params.expectedSessionId,
              fromLifecycleRevision: params.expectedLifecycleRevision,
            },
            now: params.now ?? Date.now(),
            reason: params.reason,
          });
        },
        { target },
      );
      const promotion = decodeSessionPromotion(
        result.found ? result.entry.sessionPromotion : undefined,
      );
      if (!promotion) {
        throw new SessionPromotionConflictError();
      }
      return promotion;
    },
  });
}
