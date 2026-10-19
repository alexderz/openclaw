import {
  ErrorCodes,
  errorShape,
  validateSessionsPromoteParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  SessionPromotionCancelDeniedError,
  SessionPromotionConflictError,
  SessionPromotionUnsupportedError,
  type SessionPromotion,
} from "../../sessions/session-promotion-state.js";
import { requestSessionPromotion } from "../../sessions/session-promotion.js";
import { notifySessionWorkSettled } from "../../sessions/session-work-settlement.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { GitHubPublicationRequesterUnavailableError } from "../github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "../github-publication-git-index.js";
import { captureGitHubPublicationRequester } from "../github-publication-requester.js";
import { prepareGatewaySessionAccessAuthority } from "../session-access-authority.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { isControlUiAdminClient } from "../session-promotion-client.js";
import {
  PromotionRequesterDeniedError,
  prepareFreshHumanPromotionRequester,
  readPromotionDeviceBinding,
} from "../session-promotion-human.js";
import {
  createSessionPromotionOwnerCheck,
  SessionPromotionLineageUnavailableError,
  SessionPromotionOwnershipDeniedError,
} from "../session-promotion-owner-check.js";
import {
  markSessionPromotionPending,
  clearSessionPromotionPending,
} from "../session-promotion-pending-keys.js";
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

/**
 * Server-log reason for a refused request. The client keeps one non-disclosing denial; this
 * code names the refusing owner without profile ids, grants or session contents.
 */
export function sessionPromotionRefusalReason(error: unknown): string {
  if (error instanceof PromotionRequesterDeniedError) {
    return error.reason;
  }
  if (error instanceof SessionPromotionUnsupportedError) {
    return `unsupported-target:${error.reason}`;
  }
  if (error instanceof SessionPromotionConflictError) {
    return "conflict";
  }
  if (error instanceof SessionPromotionCancelDeniedError) {
    return error.reason;
  }
  if (
    error instanceof SessionPromotionOwnershipDeniedError ||
    error instanceof SessionPromotionLineageUnavailableError
  ) {
    return error.reason;
  }
  if (error instanceof SessionMutationAuthorizationChangedError) {
    return error.error.retryable ? "session-access-refreshing" : "session-access-denied";
  }
  if (
    error instanceof GitHubPublicationRequesterUnavailableError ||
    error instanceof GitHubPublicationRecoveryPendingError
  ) {
    return "requester-capture-failed";
  }
  const name =
    error instanceof Error
      ? error.name !== "Error"
        ? error.name
        : error.constructor.name
      : typeof error;
  return `unexpected:${name.replace(/[^A-Za-z0-9_]/g, "") || "unknown"}`;
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
        throw new PromotionRequesterDeniedError("agent-unresolved");
      }
      // The key alone names the privacy boundary; this discloses nothing about any row.
      if (isIncognitoSessionKey(params.key)) {
        throw new SessionPromotionUnsupportedError("incognito");
      }
      const preparedAccess = await prepareGatewaySessionAccessAuthority({
        policy: { mode: "write" },
        requestParams: { sessionKey: params.key },
        client: options.client,
        context,
        // Ownership is the promotion rule below (admin, own session or owned lineage), enforced
        // by the durable requester on every re-check; sharing, role and agent access stay here.
        ownSessionOnly: false,
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
      // current identity, promotion ownership, agent access and session sharing facts.
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
          authorizeOwner: createSessionPromotionOwnerCheck(context, params.key, () =>
            isControlUiAdminClient(options.client),
          ),
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
              throw new PromotionRequesterDeniedError("device-pairing-unreadable");
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
        liveAdmin: isControlUiAdminClient(options.client),
      });
      // Mark before responding: a client that acts on the reply must find the key already pending.
      if (promotion.state === "pending") {
        // Mark before notifying: settlement attempts run only for keys with a pending intent.
        markSessionPromotionPending(promotion.target.key);
        // An already idle session has no owner release to wake the settlement coordinator.
        // It consumes only the intent just persisted, under its original basis.
        notifySessionWorkSettled([promotion.target.key]);
      } else {
        clearSessionPromotionPending(promotion.target.key);
      }
      respond(true, toSessionPromotionResult(promotion), undefined);
    } catch (error) {
      const reason = sessionPromotionRefusalReason(error);
      const message = `sessions.promote refused reason=${reason}`;
      if (reason.startsWith("unexpected:")) {
        context.logGateway?.warn?.(message);
      } else {
        context.logGateway?.info?.(message);
      }
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
            // Raised only after authorization, or from the key alone: safe to name.
            { details: { code: "SESSION_PROMOTION_UNSUPPORTED", reason: error.reason } },
          ),
        );
      } else if (
        error instanceof SessionMutationAuthorizationChangedError &&
        error.error.retryable
      ) {
        // Transient access preparation: not a decision, so the caller must not see a denial.
        respond(false, undefined, error.error);
      } else {
        // Do not disclose whether an inaccessible session, owner or grant exists. Lineage-unreadable
        // refusals also land here on purpose: they are deliberately non-disclosing and no longer
        // retryable, so the client gets the same final denial as any other refusal.
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
