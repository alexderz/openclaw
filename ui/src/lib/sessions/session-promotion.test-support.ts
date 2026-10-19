import type { SessionCapabilityStatus } from "../../api/types.ts";

/**
 * Per-viewer promotion projections shaped like the Gateway's projectSessionPromotion output
 * (src/gateway/session-promotion-projection.ts), not hand-tuned UI states.
 */
const base = {
  historicalOrigin: "delegated",
  effectiveClass: "delegated",
  classScope: "none",
  lifecycleRevision: "rev-one",
  canPromote: false,
  canCancel: false,
  promotionState: "none",
  disabledReasons: [],
  pendingBlockers: [],
  activationBoundary: "next-fresh-human-run-after-quiescence",
  policyEvaluatedAt: 1,
  effectiveRestrictions: ["current-role-grants-resource-policy-and-sandbox-still-apply"],
  capabilities: { sessionsSend: "unknown" },
} satisfies SessionCapabilityStatus;

export const PENDING_REQUEST_ID = "req-original-pending";

export type PromotionFixtureKind =
  | "authorized-none"
  | "authorized-pending"
  | "unauthorized-pending"
  | "restricted-viewer"
  | "stale-identity"
  | "promoted-requester"
  | "promoted-other-viewer"
  | "revoked-authorized";

export function promotionProjection(kind: PromotionFixtureKind): SessionCapabilityStatus {
  switch (kind) {
    case "authorized-none":
      return { ...base, canPromote: true };
    case "authorized-pending":
      // Backend: pending => canPromote=false, reason promotion-pending, canCancel + original id.
      return {
        ...base,
        canCancel: true,
        pendingRequestId: PENDING_REQUEST_ID,
        promotionState: "pending",
        disabledReasons: ["promotion-pending"],
        pendingBlockers: ["quiescence-and-current-human-revalidation-required"],
      };
    case "unauthorized-pending":
      return {
        ...base,
        promotionState: "pending",
        disabledReasons: ["current-human-authorization-required", "promotion-pending"],
        pendingBlockers: ["quiescence-and-current-human-revalidation-required"],
      };
    case "restricted-viewer":
      return { ...base, disabledReasons: ["current-human-authorization-required"] };
    case "stale-identity":
      return {
        ...base,
        effectiveClass: "unknown",
        promotionState: "blocked",
        disabledReasons: ["stale-or-invalid-promotion", "promotion-blocked"],
      };
    case "promoted-requester":
      // Backend: activated => ordinary for the requesting human's direct turns only.
      return {
        ...base,
        effectiveClass: "ordinary",
        classScope: "requesting-human-direct-turns",
        promotionState: "activated",
        disabledReasons: ["promotion-activated"],
      };
    case "promoted-other-viewer":
      return {
        ...base,
        classScope: "requesting-human-direct-turns",
        promotionState: "activated",
        disabledReasons: ["promotion-activated"],
      };
    case "revoked-authorized":
      // Backend: a terminal revoke keeps its state visible but does not block a new request.
      return { ...base, canPromote: true, promotionState: "revoked" };
    default:
      return kind satisfies never;
  }
}
