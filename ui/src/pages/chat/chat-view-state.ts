import { resetPlacedQueuedSends } from "./chat-progress.ts";
import { resetChatComposerState } from "./components/chat-composer.ts";
import { resetThreadPresentation } from "./components/chat-thread-interactions.ts";

export function resetChatViewState(paneId?: string, owner?: ParentNode) {
  resetPlacedQueuedSends(paneId);
  resetChatComposerState(paneId);
  resetThreadPresentation(paneId, owner);
}
