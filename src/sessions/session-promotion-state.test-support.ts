import {
  captureSessionEffectiveAdmission,
  type SessionEffectiveAdmission,
} from "./session-promotion-state.js";

/**
 * Mints admission handles through the real owner: an activated receipt on a delegated row and a
 * fresh human turn by the receipt profile. Tests never hand-build an "ordinary" handle.
 */
export function captureSessionEffectiveAdmissionForTest(params: {
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  /** "delegated" captures the same row for a queued input admitted before the handoff. */
  effectiveClass: "ordinary" | "delegated";
  humanProfileId?: string;
}): SessionEffectiveAdmission {
  const lifecycleRevision = params.lifecycleRevision ?? "after-handoff";
  const humanProfileId = params.humanProfileId ?? "human";
  const agentId = params.sessionKey.split(":")[1] ?? "main";
  const admission = captureSessionEffectiveAdmission({
    entry: {
      sessionId: params.sessionId,
      lifecycleRevision,
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
      sessionPromotion: {
        version: 1,
        state: "activated",
        requestId: "request",
        acceptedAt: 1,
        target: {
          agentId,
          key: params.sessionKey,
          sessionId: params.sessionId,
          fromLifecycleRevision: "before-handoff",
        },
        boundary: "settlement-or-fresh-human-input",
        profileId: humanProfileId,
        activatedAt: 2,
        toLifecycleRevision: lifecycleRevision,
      },
    },
    sessionKey: params.sessionKey,
    humanProfileId,
    admittedIdentity: {
      sessionId: params.sessionId,
      lifecycleRevision:
        params.effectiveClass === "ordinary" ? lifecycleRevision : "before-handoff",
    },
    assertCurrent: () => {},
    policyCeiling: {},
  });
  if (admission.effectiveClass !== params.effectiveClass) {
    throw new Error(
      `fixture captured ${admission.effectiveClass}, wanted ${params.effectiveClass}`,
    );
  }
  return admission;
}
