// Keep the active line inside the composer textarea. Keyboard-sized panes clip
// a content-sized box below the conversation, and assigning scrollTop on that
// box does not move the line back onto the screen. Callers size the textarea
// as the scrollport; this only moves its scroll offset and puts the transcript
// back if the browser followed the caret into the thread.

export function scrollTopForCaretLine(state: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  caretTop: number;
  caretBottom: number;
}): number {
  const maxScroll = Math.max(0, state.scrollHeight - state.clientHeight);
  let next = state.scrollTop;
  if (state.caretBottom > state.scrollTop + state.clientHeight + 1) {
    next = state.caretBottom - state.clientHeight;
  } else if (state.caretTop < state.scrollTop - 1) {
    next = state.caretTop;
  }
  return Math.max(0, Math.min(maxScroll, Math.ceil(next)));
}

function caretContentBounds(textarea: HTMLTextAreaElement): { top: number; bottom: number } | null {
  if (textarea.clientWidth <= 0) {
    return null;
  }
  const style = getComputedStyle(textarea);
  const line = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(line) && line > 0 ? line : 24;
  const mirror = document.createElement("div");
  mirror.style.cssText = [
    "position:absolute",
    "left:-9999px",
    "top:0",
    "visibility:hidden",
    "white-space:pre-wrap",
    "overflow-wrap:break-word",
    `width:${textarea.clientWidth}px`,
    `font:${style.font}`,
    `line-height:${style.lineHeight}`,
    `padding:${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
    "border:0",
    `box-sizing:${style.boxSizing}`,
  ].join(";");
  const end = textarea.selectionEnd ?? textarea.value.length;
  mirror.textContent = textarea.value.slice(0, end) || " ";
  document.body.appendChild(mirror);
  const bottom = mirror.scrollHeight - Number.parseFloat(style.paddingBottom);
  mirror.remove();
  return { top: bottom - lineHeight, bottom };
}

/** Scroll the textarea, not the transcript, so the caret line is inside the box. */
export function revealComposerCaret(textarea: HTMLTextAreaElement): void {
  const bounds = caretContentBounds(textarea);
  if (!bounds) {
    return;
  }
  const thread = textarea.closest(".chat")?.querySelector<HTMLElement>(".chat-thread") ?? null;
  const held = thread?.scrollTop;
  const next = scrollTopForCaretLine({
    scrollTop: textarea.scrollTop,
    scrollHeight: textarea.scrollHeight,
    clientHeight: textarea.clientHeight,
    caretTop: bounds.top,
    caretBottom: bounds.bottom,
  });
  if (Math.abs(next - textarea.scrollTop) > 1) {
    textarea.scrollTop = next;
  }
  if (thread && held !== undefined && thread.scrollTop !== held) {
    thread.scrollTop = held;
  }
}
