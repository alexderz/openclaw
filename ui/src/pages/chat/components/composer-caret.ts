// Keep the active composer caret inside the textarea. The transcript and the
// layout viewport are not scrolled to do it. Callers that observed a browser
// pan capture a hold before the pan and restore that hold afterwards.

export function activeCaretOffset(selection: {
  start: number | null;
  end: number | null;
  direction: string | null;
  valueLength: number;
}): number {
  const start = selection.start ?? 0;
  const end = selection.end ?? selection.valueLength;
  if (selection.direction === "backward") {
    return start;
  }
  return end;
}

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

type ScrollHold = {
  windowX: number;
  windowY: number;
  threadTop: number | null;
  offsetTop: number;
  offsetLeft: number;
};

const scrollHolds = new WeakMap<HTMLTextAreaElement, ScrollHold>();

function composerThread(textarea: HTMLTextAreaElement): HTMLElement | null {
  const scope = textarea.closest(".chat, .chat-main__conversation");
  return scope?.querySelector<HTMLElement>(".chat-thread") ?? null;
}

export function captureComposerScrollHold(textarea: HTMLTextAreaElement): void {
  const viewport = window.visualViewport;
  const thread = composerThread(textarea);
  scrollHolds.set(textarea, {
    windowX: window.scrollX,
    windowY: window.scrollY,
    threadTop: thread?.scrollTop ?? null,
    offsetTop: viewport?.offsetTop ?? 0,
    offsetLeft: viewport?.offsetLeft ?? 0,
  });
}

export function restoreComposerScrollHold(textarea: HTMLTextAreaElement): void {
  const hold = scrollHolds.get(textarea);
  if (!hold) {
    return;
  }
  scrollHolds.delete(textarea);
  const thread = composerThread(textarea);
  if (thread && hold.threadTop !== null && thread.scrollTop !== hold.threadTop) {
    thread.scrollTop = hold.threadTop;
  }
  if (window.scrollX !== hold.windowX || window.scrollY !== hold.windowY) {
    window.scrollTo(hold.windowX, hold.windowY);
  }
  undoComposerViewportPan(hold.offsetTop, hold.offsetLeft);
}

let undoingPan = false;

function undoComposerViewportPan(fromTop: number, fromLeft: number): void {
  const viewport = window.visualViewport;
  const scroller = document.scrollingElement;
  if (!viewport || !scroller || undoingPan) {
    return;
  }
  const dy = viewport.offsetTop - fromTop;
  const dx = viewport.offsetLeft - fromLeft;
  if (dy === 0 && dx === 0) {
    return;
  }
  undoingPan = true;
  try {
    scroller.scrollTo(scroller.scrollLeft - dx, scroller.scrollTop - dy);
  } finally {
    undoingPan = false;
  }
}

function caretContentBounds(textarea: HTMLTextAreaElement): { top: number; bottom: number } | null {
  if (textarea.clientWidth <= 0) {
    return null;
  }
  const style = getComputedStyle(textarea);
  const parsedLine = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine : 24;
  const mirror = document.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.left = "-9999px";
  mirror.style.top = "0";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.font = style.font;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.padding = `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`;
  mirror.style.border = "0";
  const offset = activeCaretOffset({
    start: textarea.selectionStart,
    end: textarea.selectionEnd,
    direction: textarea.selectionDirection,
    valueLength: textarea.value.length,
  });
  mirror.append(document.createTextNode(textarea.value.slice(0, offset)));
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const height = marker.offsetHeight || lineHeight;
  mirror.remove();
  return { top, bottom: top + height };
}

/** Scroll the textarea only. Does not move the transcript or the window. */
export function revealComposerCaret(textarea: HTMLTextAreaElement): void {
  const bounds = caretContentBounds(textarea);
  if (!bounds) {
    return;
  }
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
}

export function installComposerCaretViewport(
  textarea: HTMLTextAreaElement,
  signal: AbortSignal,
): void {
  const viewport = window.visualViewport;
  if (!viewport) {
    return;
  }
  const onViewport = () => {
    if (signal.aborted || undoingPan || document.activeElement !== textarea) {
      return;
    }
    revealComposerCaret(textarea);
    undoComposerViewportPan(0, 0);
  };
  viewport.addEventListener("resize", onViewport, { signal });
  viewport.addEventListener("scroll", onViewport, { signal });
}
