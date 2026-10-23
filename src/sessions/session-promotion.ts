import { randomUUID } from "node:crypto";
import { resolveDashboardRootParentSessionKey } from "../config/sessions/main-session.js";
import {
  resolveSessionEntryAccessTarget,
  updateResolvedSessionEntry,
  type LogicalSessionAccessScope,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { promotionAdminBasisAllowed } from "../gateway/session-promotion-ownership.js";
import type { GitHubPublicationRequesterSnapshot } from "../state/github-publication-requester.js";
import { runExclusiveSessionLifecycleMutation } from "./session-lifecycle-admission.js";
import { detachPromotedSessionEntry, hasDelegationLineage } from "./session-promotion-detach.js";
import {
  applySessionPromotionRequest,
  activatePendingSessionPromotion as activatePromotionEntry,
  decodeSessionPromotion,
  isActivatedSessionPromotionFor,
  resolveSessionPromotionTargetSupport,
  revokePendingSessionPromotion as revokePromotionEntry,
  SessionPromotionConflictError,
  SessionPromotionUnsupportedError,
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

const DASHBOARD_KEY = /^agent:[^:]+:dashboard:[^:]+$/;

/**
 * Detaches an activated row in the same store write: the parent link becomes the agent's main
 * root for a dashboard key, as session creation assigns it, unless a plugin owns the session.
 */
function detachActivatedEntry(
  scope: LogicalSessionAccessScope,
  entry: InternalSessionEntry,
  context: { agentId: string; canonicalKey: string },
): boolean {
  const receipt = decodeSessionPromotion(entry.sessionPromotion);
  if (
    receipt?.state !== "activated" ||
    !isActivatedSessionPromotionFor(context.canonicalKey, entry)
  ) {
    return false;
  }
  return detachPromotedSessionEntry({
    entry,
    key: context.canonicalKey,
    promotion: {
      requestId: receipt.requestId,
      profileId: receipt.profileId,
      activatedAt: receipt.activatedAt,
    },
    rootParentSessionKey:
      DASHBOARD_KEY.test(context.canonicalKey) && !entry.pluginOwnerId
        ? resolveDashboardRootParentSessionKey({
            cfg: scope.cfg,
            agentId: context.agentId,
            sessionKey: context.canonicalKey,
          })
        : undefined,
  });
}

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
  /** The host-attested live Control UI admin flag for this request; restore never sets it. */
  liveAdmin?: boolean;
}): Promise<SessionPromotion> {
  params.assertCurrent();
  const target = resolveSessionEntryAccessTarget(params.scope, { keyFormat: "agent-qualified" });
  if (!target.entry) {
    throw new SessionPromotionConflictError();
  }
  // Activation can restore only a configured or gateway-owner basis; a live attestation is not kept.
  const restorableAdminBasis = promotionAdminBasisAllowed({
    profileId:
      params.requester.actor.kind === "operator" ? params.requester.actor.profileId : undefined,
    cfg: params.scope.cfg,
  });
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
          // Refuse now, rather than persist an intent that activation could never restore.
          if (
            params.liveAdmin === true &&
            params.action !== "cancel" &&
            !restorableAdminBasis &&
            resolveSessionPromotionTargetSupport(context.canonicalKey, entry, { admin: false }) !==
              null &&
            resolveSessionPromotionTargetSupport(context.canonicalKey, entry, { admin: true }) ===
              null
          ) {
            throw new SessionPromotionUnsupportedError("admin-basis-unavailable");
          }
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
            // A live attested admin is a basis at request time; a restored intent has no live flag.
            adminBasisAllowed: params.liveAdmin === true || restorableAdminBasis,
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
}): Promise<{
  promotion: SessionPromotion;
  blockers: readonly string[];
  activated: boolean;
  /** The same commit turned the row into a dashboard root (see session-promotion-detach). */
  detached: boolean;
}> {
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
      return { promotion: observed, blockers: probed, activated: false, detached: false };
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
        let detached = false;
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
              // Restore re-proves the admin basis from the intent's own operator profile and config.
              adminBasisAllowed: promotionAdminBasisAllowed({
                profileId:
                  promotion.requester.actor.kind === "operator"
                    ? promotion.requester.actor.profileId
                    : undefined,
                cfg: params.scope.cfg,
              }),
              assertCurrent: params.assertCurrent,
            });
            // The handoff and the detach are one commit: the row becomes a dashboard root.
            detached = activated && detachActivatedEntry(params.scope, entry, context);
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
              detached = false;
              return false;
            },
          },
        );
        if (fenced.pending && !activated) {
          // The commit was declined; the row still holds this pending intent.
          return { promotion: fenced.pending, blockers, activated, detached: false };
        }
        const promotion = decodeSessionPromotion(
          result.found ? result.entry.sessionPromotion : undefined,
        );
        if (!promotion) {
          throw new SessionPromotionConflictError();
        }
        return { promotion, blockers, activated, detached };
      },
    });
  } finally {
    watch.stop();
  }
}

/**
 * Completes an activation that an earlier build committed without detaching the row. It takes
 * the same reservation watch, owner probe, lifecycle fence and store writer as activation, so it
 * never detaches under in-flight work; the receipt and lifecycle revision stay as they are.
 */
export async function detachActivatedSessionPromotion(params: {
  scope: LogicalSessionAccessScope;
  expectedSessionId: string;
  expectedLifecycleRevision: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  probeBlockers: (
    watch: Pick<SessionWorkAdmissionReservationWatcher, "add">,
  ) => readonly string[] | Promise<readonly string[]>;
  recheckBlockers?: (entry: InternalSessionEntry) => readonly string[];
}): Promise<{ blockers: readonly string[]; detached: boolean }> {
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
    if (probed.length > 0) {
      return { blockers: probed, detached: false };
    }
    const recheck = (entry: InternalSessionEntry) => [
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
        let detached = false;
        const fenced: { locked?: InternalSessionEntry } = {};
        await updatePromotionEntry(
          params.scope,
          (entry, context) => {
            params.signal?.throwIfAborted();
            params.assertCurrent();
            if (
              entry.sessionId !== params.expectedSessionId ||
              entry.lifecycleRevision !== params.expectedLifecycleRevision ||
              !isActivatedSessionPromotionFor(context.canonicalKey, entry)
            ) {
              throw new SessionPromotionConflictError();
            }
            if (!hasDelegationLineage(entry)) {
              return;
            }
            fenced.locked = entry;
            blockers = Object.freeze([...new Set(recheck(entry))]);
            detached = blockers.length === 0 && detachActivatedEntry(params.scope, entry, context);
          },
          {
            target,
            shouldCommit: () => {
              params.signal?.throwIfAborted();
              params.assertCurrent();
              if (!fenced.locked || !detached) {
                return false;
              }
              const late = recheck(fenced.locked);
              if (late.length === 0) {
                return true;
              }
              blockers = Object.freeze([...new Set(late)]);
              detached = false;
              return false;
            },
          },
        );
        return { blockers, detached };
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
