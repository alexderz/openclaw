import { t } from "../../../i18n/index.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";

const NOTE_FOR_MS = 1200;
const GAP_PX = 6;
const EDGE_PX = 8;

/**
 * Inline code in a message, outside code blocks and links. A tap copies its exact text:
 * on a phone, long-press belongs to the browser's selection menu, so this is the quick
 * way to get a command, path or identifier onto the clipboard.
 */
export function inlineCodeFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const code = target.closest<HTMLElement>(".chat-text code");
  if (!code || code.closest("pre, a, button, [contenteditable]")) {
    return null;
  }
  return code;
}

function selectionTouches(element: Element): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(element)) {
      return true;
    }
  }
  return false;
}

let activeNote: { element: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined;

function showCopyNote(code: HTMLElement, label: string, failed: boolean): void {
  if (activeNote) {
    clearTimeout(activeNote.timer);
    activeNote.element.remove();
  }
  const note = document.createElement("div");
  note.className = "chat-inline-code-copied";
  note.dataset.copyState = failed ? "error" : "copied";
  note.setAttribute("role", "status");
  note.textContent = label;
  // The note sits in the same layer as the code, so a modal's inert backdrop never hides it.
  (code.closest("openclaw-modal-dialog, dialog") ?? document.body).appendChild(note);
  const rect = code.getBoundingClientRect();
  const noteRect = note.getBoundingClientRect();
  const left = Math.min(
    Math.max(EDGE_PX, rect.left + rect.width / 2 - noteRect.width / 2),
    window.innerWidth - noteRect.width - EDGE_PX,
  );
  const above = rect.top - noteRect.height - GAP_PX;
  note.style.left = `${Math.max(0, left)}px`;
  note.style.top = `${above >= 0 ? above : rect.bottom + GAP_PX}px`;
  const timer = setTimeout(() => {
    note.remove();
    if (activeNote?.element === note) {
      activeNote = undefined;
    }
  }, NOTE_FOR_MS);
  activeNote = { element: note, timer };
}

/**
 * Copies the tapped inline code's exact text and briefly shows "Copied". Returns false
 * (and does nothing) when the click is not a plain tap on inline code, including while
 * the reader is selecting text in it.
 */
export function copyInlineCodeFromClick(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) {
    return false;
  }
  const code = inlineCodeFromTarget(event.target);
  const text = code?.textContent ?? "";
  if (!code || !text || selectionTouches(code)) {
    return false;
  }
  // The clipboard write starts inside this tap, which iOS Safari requires; clipboard.ts
  // falls back to execCommand where the async API is missing or refused.
  void copyToClipboard(text).then((copied) => {
    showCopyNote(code, t(copied ? "common.copied" : "common.copyFailed"), !copied);
  });
  return true;
}
