import type { SessionEntry } from "../config/sessions/types.js";
import {
  decodeSessionPromotion,
  resolveSessionPromotionTargetSupport,
} from "../sessions/session-promotion-state.js";

export type SessionPromotionProjection = {
  historicalOrigin: "delegated" | "ordinary";
  /** Class of a direct chat turn typed by THIS viewer; other turns follow `classScope`. */
  effectiveClass: "delegated" | "ordinary" | "unknown";
  /**
   * Which turns the ordinary class covers: every turn of a natively ordinary session, but only
   * the requesting human's direct Control UI turns after a promotion, on the embedded and
   * claude-cli/MCP tool paths. Completion wakes, automation, inbound `sessions_send`, other
   * people's turns, plugin harnesses, compaction, Gateway tool RPCs and spawn depth keep their
   * historical delegated result.
   */
  classScope: "all-turns" | "requesting-human-direct-turns" | "none";
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
  effectiveRestrictions: string[];
  capabilities: { sessionsSend: "allowed" | "denied" | "unknown" };
};

/** Viewer capability is computed for this read, never persisted in shared rows. */
export function projectSessionPromotion(params: {
  key: string;
  entry: Omit<SessionEntry, "sessionPromotion"> & { sessionPromotion?: unknown };
  /** The shared promotion authority predicate for THIS viewer (see session-row-presentation). */
  authorize: () => boolean;
  /** Viewer is a live, host-attested Control UI admin: widens the supported key families. */
  admin?: boolean;
  /** The viewing profile; a promotion is ordinary only for the human who requested it. */
  viewerProfileId?: string;
  now: number;
}): SessionPromotionProjection {
  const { entry, key } = params;
  const historicalDelegated = Boolean(entry.spawnedBy || (entry.spawnDepth ?? 0) > 0);
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
  return {
    historicalOrigin: historicalDelegated ? "delegated" : "ordinary",
    effectiveClass: malformed
      ? "unknown"
      : historicalDelegated
        ? promoted &&
          params.viewerProfileId !== undefined &&
          params.viewerProfileId === receipt?.profileId
          ? "ordinary"
          : "delegated"
        : "ordinary",
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
    effectiveRestrictions: ["current-role-grants-resource-policy-and-sandbox-still-apply"],
    // A receipt and tool visibility are not effect-time resource authorization.
    capabilities: { sessionsSend: "unknown" },
  };
}
