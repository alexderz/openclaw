import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { chatHistoryRequests, getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { ChatHistoryHost } from "./chat-state-contract.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

export const CHAT_REENTRY_RECONCILE_INTERVAL_MS = 10_000;

// Keyed by chat, not pane: two panes showing one chat share its budget.
const lastReconciledAt = new Map<string, number>();

/**
 * Returning to a chat keeps its cached rows on screen, then reads the newest
 * page in full so the server window replaces whatever drifted in memory
 * (repeats, lost queued bubbles, stale state). One read per entry, at most one
 * per chat every ten seconds. Returns the started load, "deferred" when the
 * reconnect's read will do it, or undefined when nothing is owed.
 */
export function reconcileChatOnReentry(
  state: ChatHistoryHost,
  now = Date.now(),
): ReturnType<typeof loadChatHistory> | "deferred" | undefined {
  const sessionKey = state.sessionKey;
  if (!sessionKey || parseCatalogSessionKey(sessionKey)) {
    return undefined;
  }
  const chatKey = resolveChatSnapshotKey(state, { sessionKey });
  const last = lastReconciledAt.get(chatKey);
  if (last !== undefined && now - last < CHAT_REENTRY_RECONCILE_INTERVAL_MS) {
    return undefined;
  }
  const requests = chatHistoryRequests(state);
  const load = getChatHistoryLoadState(state);
  // A dead or not-yet-replaced socket (Android suspends backgrounded PWAs):
  // the reconnect's own history read becomes the full read.
  if (
    !state.client ||
    !state.connected ||
    state.client.needsWakeReconnect ||
    load.phase === "pending-connection"
  ) {
    requests.reconcileWanted = sessionKey;
    return "deferred";
  }
  // A full read already in flight answers this entry; a delta read is followed by one.
  if (load.phase === "in-flight" && load.fullRead) {
    return undefined;
  }
  lastReconciledAt.set(chatKey, now);
  const reconciled = loadChatHistory(state, { reconcile: true, deferBranches: true });
  // A dropped or failed read leaves the budget for the next entry.
  const release = () => {
    if (lastReconciledAt.get(chatKey) === now) {
      lastReconciledAt.delete(chatKey);
    }
  };
  void reconciled.then((result) => result || release(), release);
  return reconciled;
}
