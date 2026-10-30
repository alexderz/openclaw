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

/** Passive events follow the caret only when its active offset changed. */
export function shouldFollowCaret(previousOffset: number | null, nextOffset: number): boolean {
  return previousOffset === null || previousOffset !== nextOffset;
}

/**
 * A viewport resize may show the caret again while the user is typing.
 * A draft they scrolled on purpose stays put until the caret moves.
 */
export function shouldRevealOnViewportResize(reading: boolean, caretMoved: boolean): boolean {
  return caretMoved || !reading;
}

/** How far the visual viewport moved from a captured hold. Never assumes 0. */
export function viewportPanDelta(
  current: { offsetTop: number; offsetLeft: number },
  hold: { offsetTop: number; offsetLeft: number },
): { dx: number; dy: number } {
  return {
    dx: current.offsetLeft - hold.offsetLeft,
    dy: current.offsetTop - hold.offsetTop,
  };
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

type CaretWatch = {
  offset: number | null;
  reading: boolean;
};

const caretWatches = new WeakMap<HTMLTextAreaElement, CaretWatch>();

export function readActiveCaretOffset(textarea: HTMLTextAreaElement): number {
  return activeCaretOffset({
    start: textarea.selectionStart,
    end: textarea.selectionEnd,
    direction: textarea.selectionDirection,
    valueLength: textarea.value.length,
  });
}

function watchFor(textarea: HTMLTextAreaElement): CaretWatch {
  const existing = caretWatches.get(textarea);
  if (existing) {
    return existing;
  }
  const created: CaretWatch = { offset: null, reading: false };
  caretWatches.set(textarea, created);
  return created;
}

export function rememberComposerCaret(textarea: HTMLTextAreaElement): void {
  const watch = watchFor(textarea);
  watch.offset = readActiveCaretOffset(textarea);
}

/** A finger scroll of the draft, not a scroll we just applied to show the caret. */
export function noteComposerDraftReading(textarea: HTMLTextAreaElement): void {
  if (revealDepth > 0) {
    return;
  }
  const watch = watchFor(textarea);
  watch.reading = true;
  watch.offset = readActiveCaretOffset(textarea);
}

let undoingPan = false;
let revealDepth = 0;

function undoComposerViewportPan(fromTop: number, fromLeft: number): void {
  const viewport = window.visualViewport;
  const scroller = document.scrollingElement;
  if (!viewport || !scroller || undoingPan) {
    return;
  }
  const delta = viewportPanDelta(viewport, { offsetTop: fromTop, offsetLeft: fromLeft });
  if (delta.dx === 0 && delta.dy === 0) {
    return;
  }
  undoingPan = true;
  try {
    scroller.scrollTo(scroller.scrollLeft - delta.dx, scroller.scrollTop - delta.dy);
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
  // The computed shorthand can be empty (for example, when longhands do not
  // serialize as a font shorthand). Copy the text metrics individually so
  // wrapping in the mirror matches the actual textarea.
  for (const property of [
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "font-stretch",
    "font-variant",
    "font-kerning",
    "font-feature-settings",
    "font-variation-settings",
    "letter-spacing",
    "word-spacing",
    "text-indent",
    "text-transform",
    "tab-size",
    "direction",
    "word-break",
  ]) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
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
    revealDepth += 1;
    try {
      textarea.scrollTop = next;
    } finally {
      revealDepth -= 1;
    }
  }
}

/** Typing, navigation, focus, and composition. These may scroll even if the index matches. */
export function revealComposerCaretForEdit(textarea: HTMLTextAreaElement): void {
  revealComposerCaret(textarea);
  const watch = watchFor(textarea);
  watch.offset = readActiveCaretOffset(textarea);
  watch.reading = false;
  restoreComposerScrollHold(textarea);
}

/** selectionchange: follow only when the active caret index moved. */
export function revealComposerCaretForCaretMove(textarea: HTMLTextAreaElement): boolean {
  if (document.activeElement !== textarea) {
    return false;
  }
  const watch = watchFor(textarea);
  const next = readActiveCaretOffset(textarea);
  if (!shouldFollowCaret(watch.offset, next)) {
    return false;
  }
  watch.reading = false;
  watch.offset = next;
  revealComposerCaret(textarea);
  restoreComposerScrollHold(textarea);
  return true;
}

export function installComposerCaretViewport(
  textarea: HTMLTextAreaElement,
  signal: AbortSignal,
): void {
  rememberComposerCaret(textarea);
  const viewport = window.visualViewport;
  if (!viewport) {
    return;
  }
  const onScroll = () => {
    if (signal.aborted || undoingPan || document.activeElement !== textarea) {
      return;
    }
    // A viewport pan is not a caret move. Do not pull the draft back, and do
    // not cancel the pan here: connectShellViewport already accounts for a
    // nonzero offsetTop. Typing restores the captured hold instead.
    revealComposerCaretForCaretMove(textarea);
  };
  const onResize = () => {
    if (signal.aborted || undoingPan || document.activeElement !== textarea) {
      return;
    }
    const watch = watchFor(textarea);
    const moved = shouldFollowCaret(watch.offset, readActiveCaretOffset(textarea));
    if (!shouldRevealOnViewportResize(watch.reading, moved)) {
      return;
    }
    revealComposerCaret(textarea);
    watch.offset = readActiveCaretOffset(textarea);
    watch.reading = false;
  };
  viewport.addEventListener("resize", onResize, { signal });
  viewport.addEventListener("scroll", onScroll, { signal });
}
