import {
  readSessionMessageIdentity,
  readSessionMessageSequence,
} from "@openclaw/gateway-client/browser";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
  ChatHistoryActivity,
  ChatHistoryDeltaResult as ProtocolChatHistoryDeltaResult,
  ChatHistoryResetResult,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow, GatewaySessionsDefaults } from "../../api/types.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-cache.ts";
import { nativeHistoryMessageIdentity } from "../../lib/chat/history-message-identity.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import type { ChatHistorySessions, ChatState } from "./chat-state-contract.ts";
import type { ChatHistoryRunObservation } from "./run-lifecycle.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  readChatHistoryCursor,
  setChatHistoryCursor,
} from "./session-message-cache.ts";
import type { AgentEventPayload } from "./tool-stream-contract.ts";

export type ChatHistoryResult = {
  activity?: ChatHistoryActivity[];
  pendingInputs?: ChatPendingInputsPage;
  inputReceipts?: ChatInputReceipts;
  deltaCursor?: string;
  windowReset?: boolean;
  messages?: Array<unknown>;
  offset?: number;
  nextOffset?: number;
  hasMore?: boolean;
  totalMessages?: number;
  completeSnapshot?: boolean;
  sessionId?: string;
  thinkingLevel?: string;
  verboseLevel?: string;
  defaults?: GatewaySessionsDefaults;
  sessionInfo?: GatewaySessionRow;
  metadata?: ChatMetadataResult;
  inFlightRun?: {
    runId: string;
    text?: string;
    startedAt?: number;
    sessionAbortable?: boolean;
    events?: AgentEventPayload[];
    plan?: { steps: Array<{ step: string; status: string }>; explanation?: string };
  };
};

export type ChatHistoryDeltaResult = Omit<
  ProtocolChatHistoryDeltaResult,
  "sessionInfo" | "inFlightRun" | "metadata"
> & {
  sessionInfo: GatewaySessionRow;
  inFlightRun?: ChatHistoryResult["inFlightRun"];
  metadata?: ChatMetadataResult;
};

export type { ChatHistoryResetResult };

export type ChatHistoryResponse =
  | ChatHistoryResult
  | ChatHistoryDeltaResult
  | ChatHistoryResetResult;

export type ChatHistoryObservation = {
  owner: ChatHistorySessions;
  reconcile: ReturnType<ChatHistorySessions["captureReconcile"]>;
  run?: ChatHistoryRunObservation;
};

export type ObservedChatHistoryResult = ChatHistoryResult & {
  observation: ChatHistoryObservation;
};

export type ObservedChatHistoryResponse = ChatHistoryResponse & {
  observation: ChatHistoryObservation;
};

export function isHistoryCursor(
  result: ChatHistoryResponse,
): result is ChatHistoryDeltaResult | ChatHistoryResetResult {
  return "kind" in result;
}

export function resolveChatHistoryPagination(
  result: ChatHistoryResult | undefined,
): ChatHistoryPagination {
  const validTotal = asSafeIntegerInRange(result?.totalMessages, { min: 0 });
  const nextOffset = asSafeIntegerInRange(result?.nextOffset, { min: 1 });
  if (result?.hasMore === true && nextOffset !== undefined) {
    return {
      hasMore: true,
      nextOffset,
      ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    };
  }
  return {
    hasMore: false,
    ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    ...(result?.completeSnapshot === true ? { completeSnapshot: true as const } : {}),
  };
}

export function historySessionId(result: ChatHistoryResult): string | null {
  return (
    normalizeNullableString(result.sessionInfo?.sessionId) ??
    normalizeNullableString(result.sessionId)
  );
}

function retainedRawHistoryStart(pagination: ChatHistoryPagination): number | null {
  const totalMessages = asSafeIntegerInRange(pagination.totalMessages, { min: 0 });
  if (totalMessages === undefined) {
    return null;
  }
  const retainedDepth = pagination.hasMore ? pagination.nextOffset : totalMessages;
  const start = totalMessages - retainedDepth + 1;
  return asSafeIntegerInRange(start, { min: 1 }) ?? null;
}

/**
 * Prove that a refreshed tail extends the displayed branch: its oldest native
 * row is the very row the previous transcript held at that position. A path to
 * one entry is unique, so every earlier retained row is shared ancestry.
 */
export function historyTailContinuesLineage(
  previousMessages: readonly unknown[],
  nextMessages: readonly unknown[],
): boolean {
  let oldest: { sequence: number; id: string } | null = null;
  for (const message of nextMessages) {
    const identity = readSessionMessageIdentity(message);
    if (
      identity?.id &&
      identity.sequence !== null &&
      !identity.isImported &&
      (!oldest || identity.sequence < oldest.sequence)
    ) {
      oldest = { sequence: identity.sequence, id: identity.id };
    }
  }
  if (!oldest) {
    return false;
  }
  const anchor = oldest;
  return previousMessages.some((message) => {
    const identity = readSessionMessageIdentity(message);
    return identity?.sequence === anchor.sequence && identity.id === anchor.id;
  });
}

export function reconcileHistoryTail(options: {
  nextMessages: unknown[];
  nextPagination: ChatHistoryPagination;
  nextSessionId: string | null;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination;
  previousSessionId: string | null;
}): { messages: unknown[]; pagination: ChatHistoryPagination } | null {
  if (
    !options.previousSessionId ||
    options.previousSessionId !== options.nextSessionId ||
    options.previousMessages.length === 0
  ) {
    return null;
  }
  const previousTotal = options.previousPagination.totalMessages;
  const nextTotal = options.nextPagination.totalMessages;
  const previousStart = retainedRawHistoryStart(options.previousPagination);
  const nextStart = retainedRawHistoryStart(options.nextPagination);
  if (
    typeof previousTotal !== "number" ||
    typeof nextTotal !== "number" ||
    previousStart === null ||
    nextStart === null ||
    nextTotal < previousTotal ||
    nextStart > previousTotal + 1 ||
    nextStart <= previousStart
  ) {
    return null;
  }
  // Pagination offsets and row sequences can live in different number spaces:
  // CLI-backed history pages by merged-index ordinal while rows keep their
  // local transcript seq. Cut at the new window's oldest native row too, so a
  // row the window already holds is never retained a second time.
  let cut = nextStart;
  const nextIds = new Set<string>();
  for (const message of options.nextMessages) {
    const identity = readSessionMessageIdentity(message);
    if (identity?.id) {
      nextIds.add(identity.id);
    }
    if (identity && identity.sequence !== null && !identity.isImported) {
      cut = Math.min(cut, identity.sequence);
    }
  }
  // The new window is authoritative for every entry it holds; identical copies
  // already retained (from an earlier merge) collapse to their first occurrence.
  const seen = new Set<string>();
  const prefix = options.previousMessages.filter((message) => {
    const seq = readSessionMessageSequence(message);
    if (seq === null || seq >= cut) {
      return false;
    }
    const id = readSessionMessageIdentity(message)?.id;
    if (id && nextIds.has(id)) {
      return false;
    }
    const identity = nativeHistoryMessageIdentity(message);
    if (identity) {
      if (seen.has(identity)) {
        return false;
      }
      seen.add(identity);
    }
    return true;
  });
  if (prefix.length === 0) {
    return null;
  }
  const retainedDepth = nextTotal - previousStart + 1;
  return {
    messages: [...prefix, ...options.nextMessages],
    pagination:
      previousStart > 1
        ? { hasMore: true, nextOffset: retainedDepth, totalMessages: nextTotal }
        : { hasMore: false, totalMessages: nextTotal },
  };
}

export function commitCurrentChatHistorySnapshot(
  state: ChatState,
  deltaCursor?: string | null,
): void {
  if (deltaCursor !== undefined) {
    setChatHistoryCursor(state, deltaCursor ?? undefined);
  }
  const cachedDeltaCursor = readChatHistoryCursor(state);
  if (!state.chatMessagesBySession) {
    return;
  }
  const sessionKey = state.sessionKey;
  const agentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    {
      ...(cachedDeltaCursor !== undefined ? { deltaCursor: cachedDeltaCursor } : {}),
      ...(state.chatDisplayedLeafEntryId !== undefined
        ? { displayedLeafEntryId: state.chatDisplayedLeafEntryId }
        : {}),
      messages: state.chatMessages,
      pagination: state.chatHistoryPagination,
      sessionId: state.currentSessionId ?? null,
    },
  );
}

export function clearHistoryCursor(state: ChatState, sessionKey: string, agentId?: string): void {
  delete state.chatHistoryCursor;
  if (!state.chatMessagesBySession) {
    return;
  }
  const snapshot = readChatSessionSnapshot(state.chatMessagesBySession, state, {
    sessionKey,
    agentId,
  });
  if (snapshot?.deltaCursor === undefined) {
    return;
  }
  const { deltaCursor: _deltaCursor, ...withoutCursor } = snapshot;
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    withoutCursor,
  );
}
