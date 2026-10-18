import {
  isActivatedOrdinarySessionEffectiveAdmission,
  type SessionEffectiveAdmission,
} from "../sessions/session-promotion-state.js";

/**
 * Class belongs to an admitted handle, not to the mutable session row or receipt. Only the exact
 * handle minted at a verified activation counts; copies and look-alikes stay delegated.
 */
export function isOrdinarySessionEffectiveAdmission(
  admission: SessionEffectiveAdmission | undefined,
  sessionId: string | undefined,
): boolean {
  return (
    isActivatedOrdinarySessionEffectiveAdmission(admission) &&
    admission?.effectiveClass === "ordinary" &&
    Boolean(sessionId) &&
    admission.sessionId === sessionId
  );
}
