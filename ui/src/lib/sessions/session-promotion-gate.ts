import type { SessionCapabilityStatus } from "../../api/types.ts";

/**
 * Request and cancel are separate Gateway authorities. Request follows canPromote and the
 * disabled reasons; cancel follows only the projected canCancel and original request id.
 * Neither is inferred from the pending label, the historical origin or the other flag.
 */
export function canRequestPromotion(status: SessionCapabilityStatus | undefined): boolean {
  return Boolean(
    status?.canPromote &&
    status.disabledReasons.length === 0 &&
    status.lifecycleRevision &&
    status.effectiveClass === "delegated" &&
    status.promotionState !== "pending" &&
    status.promotionState !== "blocked",
  );
}

/** The original pending intent id, only when this viewer is projected as allowed to cancel. */
export function pendingCancelRequestId(
  status: SessionCapabilityStatus | undefined,
): string | undefined {
  return status?.canCancel === true &&
    status.promotionState === "pending" &&
    status.lifecycleRevision &&
    status.pendingRequestId
    ? status.pendingRequestId
    : undefined;
}
