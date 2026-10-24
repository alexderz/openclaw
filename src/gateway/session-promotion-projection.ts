import type {
  ToolRestrictionOrigin,
  ToolsEffectiveRestrictionSummary,
} from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { decodeSessionPromotedFrom } from "../sessions/session-promotion-detach.js";
import {
  decodeSessionPromotion,
  resolveSessionPromotionTargetSupport,
} from "../sessions/session-promotion-state.js";

export type SessionPromotionProjection = {
  historicalOrigin: "delegated" | "ordinary";
  /** Class of a direct chat turn typed by THIS viewer; other turns follow `classScope`. */
  effectiveClass: "delegated" | "ordinary" | "unknown";
  /**
   * Which turns the ordinary class covers. "all-turns": a never-delegated session, and a promoted
   * session, which activation detaches into a root exactly like a dashboard session a human
   * created (every turn kind, depth 0, no parent authority or routing). Only a `:subagent:` key,
   * delegated by its key shape, keeps "requesting-human-direct-turns" after activation: the
   * requesting human's direct Control UI turns are ordinary, every other turn stays delegated.
   */
  classScope: "all-turns" | "requesting-human-direct-turns" | "none";
  /** History of a detached promotion, for display only. */
  promotedFrom?: { parentSessionKey?: string; at: number };
  lifecycleRevision?: string;
  canPromote: boolean;
  /** True only for a viewer who is currently authorized to cancel the pending intent. */
  canCancel: boolean;
  /** Original pending intent id; emitted only together with canCancel, never as authority. */
  pendingRequestId?: string;
  promotionState: "none" | "pending" | "activated" | "revoked" | "blocked";
  disabledReasons: string[];
  pendingBlockers: string[];
  activationBoundary: "next-fresh-human-run-after-quiescence";
  policyEvaluatedAt: number;
  /** Delegation layers that limit this session compared with an ordinary one; [] when none. */
  effectiveRestrictions: ToolRestrictionOrigin[];
  capabilities: { sessionsSend: "allowed" | "denied" | "unknown" };
  /** Present only when the values above come from a matching `tools.effective` evaluation. */
  toolLimits?: { count: number; evaluatedAt: number };
};

/** Viewer capability is computed for this read, never persisted in shared rows. */
export function projectSessionPromotion(params: {
  key: string;
  entry: Omit<SessionEntry, "sessionPromotion" | "promotedFrom"> & {
    sessionPromotion?: unknown;
    promotedFrom?: unknown;
  };
  /** The shared promotion authority predicate for THIS viewer (see session-row-presentation). */
  authorize: () => boolean;
  /** Viewer is a live, host-attested Control UI admin: widens the supported key families. */
  admin?: boolean;
  /** The viewing profile; a promotion is ordinary only for the human who requested it. */
  viewerProfileId?: string;
  /** Latest `tools.effective` summary for this exact session revision, if one was computed. */
  toolRestrictions?: ToolsEffectiveRestrictionSummary;
  now: number;
}): SessionPromotionProjection {
  const { entry, key } = params;
  const historicalDelegated = Boolean(entry.spawnedBy || (entry.spawnDepth ?? 0) > 0);
  const promotedFrom = decodeSessionPromotedFrom(entry.promotedFrom);
  const receipt = decodeSessionPromotion(entry.sessionPromotion);
  const targetMatches = Boolean(
    receipt &&
    receipt.target.key === key &&
    receipt.target.sessionId === entry.sessionId &&
    (receipt.state === "activated"
      ? receipt.toLifecycleRevision === entry.lifecycleRevision
      : receipt.target.fromLifecycleRevision === entry.lifecycleRevision),
  );
  const malformed = entry.sessionPromotion !== undefined && (!receipt || !targetMatches);
  const promoted = receipt?.state === "activated" && targetMatches;
  const unsupported = resolveSessionPromotionTargetSupport(
    key,
    { ...entry, sessionPromotion: receipt },
    { admin: params.admin === true },
  );
  const eligible = !unsupported && Boolean(entry.sessionId && entry.lifecycleRevision);
  let authorized = false;
  try {
    authorized = params.authorize();
  } catch {
    /* Unknown authority never becomes permission. */
  }
  const promotionState = malformed
    ? "blocked"
    : receipt?.state === "cancelled"
      ? "none"
      : (receipt?.state ?? "none");
  const disabledReasons: string[] = [];
  if (!eligible) {
    disabledReasons.push(`unsupported-target:${unsupported ?? "no-revision"}`);
  }
  if (!authorized) {
    disabledReasons.push("current-human-authorization-required");
  }
  if (malformed) {
    disabledReasons.push("stale-or-invalid-promotion");
  }
  if (promotionState !== "none" && promotionState !== "revoked") {
    disabledReasons.push("promotion-" + promotionState);
  }
  const canCancel =
    eligible && authorized && !malformed && receipt?.state === "pending" && targetMatches;
  const effectiveClass = malformed
    ? "unknown"
    : historicalDelegated
      ? promoted &&
        params.viewerProfileId !== undefined &&
        params.viewerProfileId === receipt?.profileId
        ? "ordinary"
        : "delegated"
      : "ordinary";
  // The tool surface was evaluated for one class; a promoted requester's own turns, or a stale
  // evaluation, run under the other one, so its limits say nothing about this viewer's turns.
  const restrictions =
    params.toolRestrictions?.evaluatedClass === effectiveClass
      ? params.toolRestrictions
      : undefined;
  return {
    historicalOrigin: historicalDelegated || promotedFrom ? "delegated" : "ordinary",
    effectiveClass,
    classScope: historicalDelegated
      ? promoted && !malformed
        ? "requesting-human-direct-turns"
        : "none"
      : "all-turns",
    lifecycleRevision: entry.lifecycleRevision,
    canPromote:
      eligible &&
      authorized &&
      !malformed &&
      (promotionState === "none" || promotionState === "revoked"),
    canCancel,
    ...(canCancel && receipt ? { pendingRequestId: receipt.requestId } : {}),
    promotionState,
    disabledReasons,
    pendingBlockers:
      promotionState === "pending" ? ["quiescence-and-current-human-revalidation-required"] : [],
    activationBoundary: "next-fresh-human-run-after-quiescence",
    policyEvaluatedAt: params.now,
    effectiveRestrictions: restrictions
      ? [...new Set(restrictions.limitedTools.flatMap((tool) => tool.origins))].toSorted()
      : [],
    // Tool visibility only: effect-time send and resource policy still apply.
    capabilities: { sessionsSend: restrictions?.sessionsSend ?? "unknown" },
    ...(restrictions
      ? {
          toolLimits: {
            count: restrictions.limitedTools.length,
            evaluatedAt: restrictions.evaluatedAt,
          },
        }
      : {}),
    ...(promotedFrom && !historicalDelegated
      ? {
          promotedFrom: {
            ...(promotedFrom.parentSessionKey
              ? { parentSessionKey: promotedFrom.parentSessionKey }
              : {}),
            at: promotedFrom.at,
          },
        }
      : {}),
  };
}
