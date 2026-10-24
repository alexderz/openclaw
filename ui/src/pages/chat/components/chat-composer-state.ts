import type { ChatQueueItem, HumanMention } from "../../../lib/chat/chat-types.ts";
import type { ChatRunUiStatus } from "../run-lifecycle.ts";
import {
  adjustTextareaHeight,
  disconnectComposerPopoverAnchorObserver,
} from "./chat-composer-dom.ts";
import { ComposerEmojiMenu } from "./chat-composer-emoji.ts";
import { clearGoalElapsedTimers } from "./chat-composer-goal.ts";
import { HumanMentionMenu } from "./chat-composer-mention-menu.ts";
import { createSkillMenuState } from "./chat-composer-skill-menu.ts";
import { createSlashMenuState } from "./chat-composer-slash-menu.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

function createChatComposerState(): ChatComposerState {
  return {
    ...createSlashMenuState(),
    ...createSkillMenuState(),
    composerComposing: false,
    editRevision: 0,
    mentionMenu: new HumanMentionMenu(),
    emojiMenu: new ComposerEmojiMenu(),
    composingDraft: null,
    composerInputIntentKey: null,
    pendingClearedSubmittedDraft: null,
    compositionText: "",
    compositionEndedAt: Number.NEGATIVE_INFINITY,
    compositionEndedMultiWord: false,
    compositionSend: null,
    flushCompositionSend: null,
    submissionEcho: null,
    goalExpandedId: null,
    goalComposer: null,
    activeQuestionKey: null,
    gatewayQuestionIds: new Set(),
    asyncQuestionIds: new Set(),
    questionCollapsed: false,
    questionTakeoverActive: false,
    restoreComposerFocus: false,
    composerInput: null,
    composerTextarea: null,
    microphonePicker: null,
    capabilityMenuOpen: false,
    capabilityMenuView: "root",
    textareaRef: null,
    composerInputRef: null,
    dictation: null,
    composerDraftScopeKey: null,
    dictationError: null,
    dictationSelection: null,
  };
}

const composerStates = new Map<string, ChatComposerState>();

export function getChatComposerState(paneId: string): ChatComposerState {
  const existing = composerStates.get(paneId);
  if (existing) {
    return existing;
  }
  const state = createChatComposerState();
  composerStates.set(paneId, state);
  return state;
}

export function hasTerminalRunStatus(status: ChatRunUiStatus | null | undefined): boolean {
  return status?.phase === "done" || status?.phase === "interrupted";
}

export function isCurrentSessionSubmittedProgress(
  item: ChatQueueItem,
  sessionKey: string,
  status: ChatRunUiStatus | null | undefined,
): boolean {
  return (
    item.sessionKey === sessionKey &&
    !item.pendingRunId &&
    (item.sendState === "submitting" ||
      item.sendState === "sending" ||
      item.sendState === "waiting-model") &&
    (status == null || item.sendRunId !== status.runId)
  );
}

// Single source for "the selected session is visibly working": drives both
// the thread's working spark and the composer's sr-only announcement.
export function isChatRunWorking(
  props: Pick<ChatComposerProps, "runActive" | "runStatus" | "queue" | "sessionKey">,
): boolean {
  return (
    (props.runActive === true && !hasTerminalRunStatus(props.runStatus)) ||
    props.queue.some((item) =>
      isCurrentSessionSubmittedProgress(item, props.sessionKey, props.runStatus),
    )
  );
}

export function composerDraftKey(
  props: Pick<ChatComposerProps, "currentAgentId" | "sessionKey">,
): string {
  return `${props.currentAgentId}\u0000${props.sessionKey}`;
}

export function commitComposerDraft(
  props: ChatComposerProps,
  value: string,
  mentions?: readonly HumanMention[],
): void {
  const currentDraft = props.getDraft ? props.getDraft() : props.draft;
  if (currentDraft === value && mentions === undefined) {
    return;
  }
  const previousMentions = props.getMentions?.() ?? props.mentions ?? [];
  getChatComposerState(props.paneId).editRevision += 1;
  props.onDraftChange(value, mentions);
  const nextMentions = props.getMentions?.() ?? mentions ?? props.mentions ?? [];
  // Moving a token while typing prose changes its span, not the recipient strip.
  if (
    previousMentions.length !== nextMentions.length ||
    previousMentions.some((previous, index) => {
      const next = nextMentions[index]!;
      return (
        previous.profileId !== next.profileId ||
        currentDraft.slice(previous.start, previous.end) !== value.slice(next.start, next.end)
      );
    })
  ) {
    props.onRequestUpdate?.();
  }
}

export function markComposerInputIntent(state: ChatComposerState, key: string): void {
  state.editRevision += 1;
  state.composerInputIntentKey = key;
}

export function consumeComposerInputIntent(state: ChatComposerState, key: string): boolean {
  if (state.composerInputIntentKey !== key) {
    return false;
  }
  state.composerInputIntentKey = null;
  return true;
}

export function clearPendingClearedSubmittedDraft(state: ChatComposerState, key: string): void {
  if (state.pendingClearedSubmittedDraft?.key === key) {
    state.pendingClearedSubmittedDraft = null;
  }
}

export function suppressStaleSubmittedDraftReplay(
  target: HTMLTextAreaElement,
  event: InputEvent,
  currentDraft: string,
  hasInputIntent: boolean,
  state: ChatComposerState,
): boolean {
  const pending = state.pendingClearedSubmittedDraft;
  if (
    !pending ||
    target.value !== pending.value ||
    hasInputIntent ||
    event.inputType === "insertFromPaste" ||
    event.inputType === "insertFromDrop"
  ) {
    return false;
  }

  target.value = currentDraft;
  adjustTextareaHeight(target);
  return true;
}

// Voice IMEs (Gboard dictation) commit their final words about a second and a
// half after the user stops; bound the wait so a stuck composition cannot hold
// the send forever.
export const COMPOSITION_SEND_TIMEOUT_MS = 3000;
// An IME that loses its composition to the post-send clear re-commits the
// utterance shortly after; past this window new text is the user's own.
export const SUBMISSION_ECHO_WINDOW_MS = 5000;
// A dictated phrase that ended this recently may still be re-committed.
const RECENT_COMPOSITION_MS = 1500;

// Dictation composes whole phrases; a keyboard composes one word at a time.
export function isMultiWordComposition(text: string): boolean {
  return /\S\s+\S/u.test(text);
}

// Only touch keyboards dictate into the composer. Desktop IMEs (pinyin shows
// spaces too) keep sending at once, as they always have.
export function waitsForDictationCommit(): boolean {
  return globalThis.matchMedia?.("(pointer: coarse)")?.matches === true;
}

export function cancelCompositionSend(state: ChatComposerState): void {
  if (state.compositionSend) {
    clearTimeout(state.compositionSend.timer);
    state.compositionSend = null;
  }
}

/**
 * Whether a send now could leave a dictated phrase for the IME to re-commit:
 * it cuts a multi-word composition short or follows one that just ended.
 */
export function sendMayCutDictation(state: ChatComposerState): boolean {
  return state.composerComposing
    ? isMultiWordComposition(state.compositionText)
    : state.compositionEndedMultiWord &&
        performance.now() - state.compositionEndedAt < RECENT_COMPOSITION_MS;
}

export function recordSubmissionEcho(
  state: ChatComposerState,
  key: string,
  value: string,
  mayReplay: boolean,
): void {
  const trimmed = value.trim();
  state.submissionEcho =
    mayReplay && trimmed ? { key, value: trimmed, at: performance.now(), replay: null } : null;
}

// The sent text again, whole words only, optionally followed by more words.
function echoRemainder(value: string, echo: string): string | null {
  const text = value.trimStart();
  if (!text.startsWith(echo)) {
    return null;
  }
  const rest = text.slice(echo.length);
  return rest === "" || /^\s/u.test(rest) ? rest.trimStart() : null;
}

/**
 * Classifies the first edit after a send. An IME replay inserts the whole
 * submitted text into the cleared composer in one input event; typing cannot.
 * Returns true while the edit is (part of) a replay.
 */
export function observeSubmissionEcho(
  state: ChatComposerState,
  key: string,
  value: string,
  currentDraft: string,
): boolean {
  const echo = state.submissionEcho;
  if (!echo || echo.key !== key || performance.now() - echo.at > SUBMISSION_ECHO_WINDOW_MS) {
    state.submissionEcho = null;
    return false;
  }
  if (echo.replay === null) {
    const draft = currentDraft.trim();
    if (draft === echo.value) {
      // The host has not cleared the sent draft yet; this edit is not a replay.
      return false;
    }
    echo.replay = draft === "" && echoRemainder(value, echo.value) !== null;
    if (!echo.replay) {
      state.submissionEcho = null;
    }
  }
  return echo.replay;
}

/**
 * Drops the replayed, already-sent text once the IME has committed, keeping
 * only words the first send missed. Returns true when the textarea changed.
 */
export function stripSubmissionEcho(
  state: ChatComposerState,
  key: string,
  target: HTMLTextAreaElement,
): boolean {
  const echo = state.submissionEcho;
  // The clear itself can end the open composition before any replay arrives.
  if (!echo?.replay || echo.key !== key) {
    return false;
  }
  state.submissionEcho = null;
  const remainder = echoRemainder(target.value, echo.value);
  if (remainder === null) {
    return false;
  }
  target.value = remainder;
  adjustTextareaHeight(target);
  return true;
}

function disposeChatComposerState(state: ChatComposerState) {
  cancelCompositionSend(state);
  state.emojiMenu.close();
  state.mentionMenu.dispose();
  state.composerDraftScopeKey = null;
  state.dictation?.dispose();
  state.microphonePicker?.dispose();
  if (state.composerInput) {
    disconnectComposerPopoverAnchorObserver(state.composerInput);
  }
}

export function resetChatComposerState(paneId?: string) {
  if (paneId) {
    // Goal elapsed timers are keyed by element and cleaned up when their
    // element leaves the DOM, so a per-pane reset does not need to touch them.
    const paneState = composerStates.get(paneId);
    if (paneState) {
      disposeChatComposerState(paneState);
    }
    composerStates.delete(paneId);
    return;
  }
  for (const state of composerStates.values()) {
    disposeChatComposerState(state);
  }
  composerStates.clear();
  clearGoalElapsedTimers();
}
