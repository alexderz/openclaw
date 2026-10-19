import {
  ErrorCodes,
  errorShape,
  validateSessionsPromoteParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  SessionPromotionConflictError,
  SessionPromotionUnsupportedError,
  type SessionPromotion,
} from "../../sessions/session-promotion-state.js";
import { requestSessionPromotion } from "../../sessions/session-promotion.js";
import { notifySessionWorkSettled } from "../../sessions/session-work-settlement.js";
import { captureGitHubPublicationRequester } from "../github-publication-requester.js";
import { prepareGatewaySessionAccessAuthority } from "../session-access-authority.js";
import {
  PromotionRequesterDeniedError,
  prepareFreshHumanPromotionRequester,
  readPromotionDeviceBinding,
} from "../session-promotion-human.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** Typed, sanitized acknowledgement: no principal, scope, grant or binding evidence. */
export function toSessionPromotionResult(promotion: SessionPromotion) {
  if (promotion.state === "revoked" || promotion.state === "blocked") {
    // The viewer projection explains a terminal revoked/blocked intent; a new request id starts over.
    throw new SessionPromotionConflictError();
  }
  const activated = promotion.state === "activated";
  return {
    key: promotion.target.key,
    sessionId: promotion.target.sessionId,
    lifecycleRevision: activated
      ? promotion.toLifecycleRevision
      : promotion.target.fromLifecycleRevision,
    requestId: promotion.requestId,
    state: promotion.state,
    activation: "safe-boundary-before-fresh-human-run" as const,
    effective: { class: activated ? ("ordinary" as const) : ("delegated" as const) },
  };
}

export const sessionPromotionHandlers: GatewayRequestHandlers = {
  "sessions.promote": async (options) => {
    const { params, respond, context } = options;
    if (!assertValidParams(params, validateSessionsPromoteParams, "sessions.promote", respond)) {
      return;
    }
    let release: (() => void) | undefined;
    let releaseAccess: (() => void) | undefined;
    try {
      const human = prepareFreshHumanPromotionRequester(options);
      const assertHumanCurrent = human.assertCurrent;
      const cfg = context.getRuntimeConfig();
      const owner = resolveRequestedSessionAgentId(cfg, params.key);
      if (!owner.ok) {
        throw new PromotionRequesterDeniedError();
      }
      const preparedAccess = await prepareGatewaySessionAccessAuthority({
        policy: { mode: "write" },
        requestParams: { sessionKey: params.key },
        client: options.client,
        context,
        ownSessionOnly: true,
        assertInvocationCurrent: assertHumanCurrent,
        hasCurrentClientAuthority: () => {
          assertHumanCurrent();
          return true;
        },
      });
      const access = preparedAccess.authority;
      releaseAccess = access.release;
      preparedAccess.assertPreparationCurrent();
      assertHumanCurrent();
      access.assertCurrent();
      // This admission captures the existing immutable role/grant basis and prepares
      // current identity, creator ownership, agent access and session sharing facts.
      const admitted = await captureGitHubPublicationRequester(
        {
          ...options,
          hasCurrentClientAuthority: () => {
            assertHumanCurrent();
            return true;
          },
        },
        {
          sessionKey: params.key,
          agentId: owner.agentId,
        },
      );
      release = admitted.release;
      const assertCurrent = () => {
        assertHumanCurrent();
        access.assertCurrent();
        admitted.requester.assertCurrent();
      };
      assertCurrent();
      const action = params.action ?? "request";
      // A new intent records the device's pairing incarnation, so a later unpair or re-pair ends
      // it. Unreadable pairing state cannot prove that binding: refuse rather than record none.
      // Cancelling never depends on the device.
      const device =
        action === "request"
          ? await readPromotionDeviceBinding(human.deviceId).catch(() => {
              throw new PromotionRequesterDeniedError();
            })
          : undefined;
      assertCurrent();
      const promotion = await requestSessionPromotion({
        scope: { cfg, agentId: owner.agentId, sessionKey: params.key },
        expectedSessionId: params.expectedSessionId,
        expectedLifecycleRevision: params.expectedLifecycleRevision,
        requestId: params.requestId,
        action,
        ...(device ? { device } : {}),
        requester: admitted.requester.snapshot,
        signal: options.signal,
        assertCurrent,
      });
      respond(true, toSessionPromotionResult(promotion), undefined);
      if (promotion.state === "pending") {
        // An already idle session has no owner release to wake the settlement coordinator.
        // It consumes only the intent just persisted, under its original basis.
        notifySessionWorkSettled([promotion.target.key]);
      }
    } catch (error) {
      if (error instanceof SessionPromotionConflictError) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Session promotion target or request changed.", {
            details: { code: "SESSION_PROMOTION_CONFLICT" },
          }),
        );
      } else if (error instanceof SessionPromotionUnsupportedError) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Session promotion is not available for this target.",
          ),
        );
      } else {
        // Do not disclose whether an inaccessible session, owner or grant exists.
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "Session promotion is not available."),
        );
      }
    } finally {
      release?.();
      releaseAccess?.();
    }
  },
};
