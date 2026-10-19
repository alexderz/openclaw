import { isBrowserOperatorUiClient } from "../../utils/message-channel.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { activateSessionPromotionBeforeAdmission } from "./sessions-promotion-activation.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type BoundaryOptions = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "signal" | "sessionMutationAuthorization" | "hasCurrentClientAuthority"
>;

/**
 * A direct human turn is a new, directly typed main-turn from a live Control UI.
 * Replays, queued or restored input, goal/provider-review continuations, system-provenance
 * input, stop commands and model or automation turns are never a promotion boundary.
 */
export function isDirectHumanChatTurn(request: NormalizedChatSendRequest): boolean {
  return !(
    request.turnKind !== "main" ||
    request.stopCommand ||
    request.systemInputProvenance ||
    request.systemProvenanceReceipt ||
    request.goalOperation ||
    request.providerReviewAcknowledgment ||
    request.reconnectResumeRequested ||
    !isBrowserOperatorUiClient(request.clientInfo)
  );
}

export function isFreshHumanChatAdmission(
  request: NormalizedChatSendRequest,
  options: { trustedSystemInput?: boolean; context: BoundaryOptions["context"] },
): boolean {
  if (options.trustedSystemInput || !isDirectHumanChatTurn(request)) {
    return false;
  }
  const runId = request.p.idempotencyKey;
  return !(
    options.context.dedupe.has(pendingChatSendDedupeKey(runId)) ||
    options.context.dedupe.has(`chat:${runId}`) ||
    options.context.chatAbortControllers.has(runId)
  );
}

/**
 * Runs BEFORE the session is loaded and before any pending admission or work lease exists,
 * so the admission that follows captures the post-handoff lifecycle revision and policy from
 * a fresh read. Activation failure never fails the chat: the session simply stays delegated
 * and the intent stays pending (or terminal) for the next boundary.
 */
export async function activatePendingPromotionBeforeChatSend(params: {
  request: NormalizedChatSendRequest;
  options: BoundaryOptions;
  trustedSystemInput?: boolean;
}): Promise<void> {
  const { request, options } = params;
  if (
    !isFreshHumanChatAdmission(request, {
      trustedSystemInput: params.trustedSystemInput,
      context: options.context,
    })
  ) {
    return;
  }
  try {
    await activateSessionPromotionBeforeAdmission({
      options,
      sessionKey: request.p.sessionKey,
      agentIdOverride: request.p.agentId,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    options.context.logGateway?.warn?.(
      `session promotion activation deferred: ${error instanceof Error ? error.name : "error"}`,
    );
  }
}
