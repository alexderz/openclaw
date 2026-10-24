import { measureElement, type VirtualItem, type Virtualizer } from "@tanstack/virtual-core";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { captureChatSessionScrollPosition, type ChatSessionScrollPosition } from "../scroll.ts";
import type { TranscriptViewportMeasurement } from "./chat-transcript-scroll-events.ts";

export const POSITION_RAIL_MARKER_HEIGHT = 12;
const POSITION_RAIL_MARKER_OVERSCAN = 6;

export function positionRailWindowIndexes(
  count: number,
  markerIndexes: ReadonlyMap<string, number>,
  offset: number,
  height: number,
  ...retainedIds: readonly (string | null | undefined)[]
): number[] {
  const start = Math.max(
    0,
    Math.floor(offset / POSITION_RAIL_MARKER_HEIGHT) - POSITION_RAIL_MARKER_OVERSCAN,
  );
  const end = Math.min(
    count,
    Math.ceil((offset + height) / POSITION_RAIL_MARKER_HEIGHT) + POSITION_RAIL_MARKER_OVERSCAN,
  );
  const indexes = new Set<number>();
  for (let index = start; index < end; index++) {
    indexes.add(index);
  }
  // Roving Tab entry and an explored focus survive an independently scrolled rail.
  for (const id of retainedIds) {
    const index = id ? markerIndexes.get(id) : undefined;
    if (index !== undefined) {
      indexes.add(index);
    }
  }
  return [...indexes].toSorted((left, right) => left - right);
}

export type PositionRailReaderState = {
  viewport?: ChatSessionScrollPosition & { height: number };
  resizeTarget?: { offset: number; atEnd: boolean };
  followingResize: boolean;
  followActive: boolean;
};

export function resolvePositionRailReaderViewport(
  previous: PositionRailReaderState,
  measured: TranscriptViewportMeasurement,
  focused: boolean,
): { state: PositionRailReaderState; scheduleLayout: boolean } {
  const viewport = {
    height: measured.clientHeight,
    ...captureChatSessionScrollPosition(measured),
  };
  const state = { ...previous, viewport };
  let scheduleLayout = false;
  if (previous.viewport && viewport.height !== previous.viewport.height) {
    // Intersections can precede resize compensation. Preserve the reader's
    // rail offset while keeping any keyboard-focused marker in view.
    state.followingResize = true;
    state.followActive ||= focused;
    scheduleLayout ||= state.followActive;
    // A measured end supersedes startup's non-end estimate; smooth follow may still be pending.
    const atEnd = state.resizeTarget?.atEnd || previous.viewport.anchorToEnd;
    const maxOffset = Math.max(0, measured.scrollHeight - viewport.height);
    state.resizeTarget = {
      offset: atEnd ? maxOffset : Math.min(previous.viewport.scrollTop, maxOffset),
      atEnd,
    };
  }
  // Navigation and a resize can arrive in the same observer delivery.
  if (previous.viewport && viewport.scrollTop !== previous.viewport.scrollTop) {
    const target = state.resizeTarget?.offset;
    // Smooth resize compensation crosses intermediate offsets before its target.
    // The transcript input owner retires it when the reader takes over.
    const compensating =
      target !== undefined &&
      (Math.abs(viewport.scrollTop - target) <= 1 ||
        (viewport.scrollTop >= Math.min(previous.viewport.scrollTop, target) &&
          viewport.scrollTop <= Math.max(previous.viewport.scrollTop, target)));
    if (!compensating) {
      if (state.followingResize) {
        state.followActive = true;
        scheduleLayout = true;
      }
      state.followingResize = false;
      state.resizeTarget = undefined;
    }
  }
  return { state, scheduleLayout };
}

/** Row offsets start below the scroll padding plus the in-flow history header. */
export function resolveTranscriptScrollMargin(
  scrollElement: Element | null,
  headerHeight: number,
): number {
  const margin =
    scrollElement instanceof HTMLElement && typeof getComputedStyle === "function"
      ? Number.parseFloat(getComputedStyle(scrollElement).paddingTop)
      : 0;
  return (Number.isFinite(margin) ? margin : 0) + headerHeight;
}

export function syncScrollMargin(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  scrollMargin: number,
): void {
  if (scrollMargin === virtualizer.options.scrollMargin) {
    return;
  }
  virtualizer.setOptions({
    ...virtualizer.options,
    scrollMargin,
  });
}

export function initialTranscriptRect() {
  return {
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  };
}

export function measureConnectedTranscriptRows(
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): boolean {
  const rect = scrollElement?.getBoundingClientRect();
  if (
    !scrollElement ||
    virtualizer.scrollElement !== scrollElement ||
    !rect?.width ||
    !rect.height
  ) {
    return false;
  }
  // Width changes and retired smooth commands can have undelivered sizes.
  // Ordinary row refs stay on TanStack's observer path; never clear its cache.
  const measurements: Array<{ index: number; height: number }> = [];
  for (const row of scrollElement.querySelectorAll<HTMLElement>(".chat-virtual-row")) {
    const index = virtualizer.indexFromElement(row);
    // Rows are border-boxes; read their fractional layout height, not a scaled
    // client rect when a containing board or sidebar is transitioning.
    const height = Number.parseFloat(getComputedStyle(row).height);
    measurements.push({ index, height: Number.isFinite(height) ? height : row.offsetHeight });
  }
  let changed = false;
  for (const { index, height } of measurements) {
    const key = virtualizer.options.getItemKey(index);
    const previousSize = virtualizer.itemSizeCache.get(key);
    virtualizer.resizeItem(index, height);
    changed ||= virtualizer.itemSizeCache.get(key) !== previousSize;
  }
  return changed;
}

export function measureTranscriptRow(
  element: HTMLElement,
  entry: ResizeObserverEntry | undefined,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): number {
  if (entry || !virtualizer.targetWindow?.ResizeObserver) {
    // Rounded row heights accumulate when skipped overscan uses those measurements.
    const size =
      entry?.borderBoxSize?.[0]?.blockSize ?? measureElement(element, entry, virtualizer);
    if (size !== 0 || virtualizer.scrollElement?.clientHeight !== 0) {
      return size;
    }
  }
  // Lit registration waits for the observer's first layout; hidden panels retain
  // their last measurement instead of replacing it with zero and moving the viewport.
  const index = virtualizer.indexFromElement(element);
  return (
    virtualizer.itemSizeCache.get(virtualizer.options.getItemKey(index)) ??
    virtualizer.options.estimateSize(index)
  );
}

export type TranscriptReaderMark = {
  /** The virtual row holding the reader's top line. */
  row: HTMLElement;
  /** Where the line sat, in viewport coordinates, when last observed. */
  top: number;
  measure: () => number | null;
};

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** The text (or element) on the reader's top line, finer than its paragraph. */
function readerLineAt(document: CaretDocument, x: number, y: number): (() => number | null) | null {
  const caret = document.caretPositionFromPoint?.(x, y);
  const range = caret ? null : document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset ?? 0;
  if (node?.nodeType === Node.TEXT_NODE && (node.textContent?.length ?? 0) > 0) {
    const start = Math.min(offset, node.textContent!.length - 1);
    return () => {
      if (!node.isConnected || start >= (node.textContent?.length ?? 0)) {
        return null;
      }
      const glyph = document.createRange();
      glyph.setStart(node, start);
      glyph.setEnd(node, start + 1);
      const rect = glyph.getBoundingClientRect();
      return rect.height > 0 ? rect.top : null;
    };
  }
  const element = document.elementFromPoint?.(x, y);
  return element ? () => (element.isConnected ? element.getBoundingClientRect().top : null) : null;
}

/** The line on the reader's top edge while they hold a position. */
export function captureTranscriptReaderMark(
  scrollElement: HTMLElement | null,
  following: boolean,
): TranscriptReaderMark | null {
  if (!scrollElement || following) {
    return null;
  }
  const viewport = scrollElement.getBoundingClientRect();
  if (viewport.width === 0 || viewport.height === 0) {
    return null;
  }
  const document = scrollElement.ownerDocument as CaretDocument;
  const x = viewport.left + viewport.width / 2;
  const y = viewport.top + 4;
  const target = document.elementFromPoint?.(x, y);
  const row =
    target && scrollElement.contains(target)
      ? target.closest<HTMLElement>(".chat-virtual-row")
      : null;
  const measure = row ? readerLineAt(document, x, y) : null;
  const top = measure?.();
  return row && measure && top != null ? { row, top, measure } : null;
}

/** How far a resize inside the mark's row moved the reader's line, or null for another row. */
export function transcriptReaderMarkShift(
  mark: TranscriptReaderMark,
  rowKey: VirtualItem["key"],
): number | null {
  if (!mark.row.isConnected || mark.row.dataset.virtualRowKey !== String(rowKey)) {
    return null;
  }
  const top = mark.measure();
  return top === null ? null : top - mark.top;
}

/**
 * Whether a row's height change shifts the scroll offset by the same amount.
 * First measurements of rows above the viewport always compensate. While the
 * reader holds a position, a re-measured row compensates when it sits wholly
 * above the viewport, also while they scroll up: virtual-core's default skips
 * that case, so a late image, embed or collapsing card above moved the text
 * being read. A row spanning the viewport top compensates when the change
 * moved the reader's top line by exactly its size change, i.e. it happened
 * above that line. A following transcript keeps the default.
 */
export function shouldCompensateTranscriptRowResize(
  item: VirtualItem,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  following: boolean,
  delta = 0,
  readerMarkShift: number | null = null,
): boolean {
  const offset = (virtualizer.scrollOffset ?? 0) + virtualizer.scrollAdjustments;
  if (!virtualizer.itemSizeCache.has(item.key)) {
    return item.start < offset;
  }
  const size = virtualizer.itemSizeCache.get(item.key) ?? item.size;
  if (item.start + size <= offset) {
    return !following || virtualizer.scrollDirection !== "backward";
  }
  return (
    !following &&
    item.start < offset &&
    readerMarkShift !== null &&
    readerMarkShift !== 0 &&
    Math.abs(readerMarkShift - delta) <= 1
  );
}

/**
 * Keeps the reader's top line still while they hold a position. Rows wholly
 * above it compensate through virtual-core; a resize inside the row that spans
 * the viewport top is settled after the update commits, by the line's own net
 * displacement, so a change partly above and partly below it (two images) or
 * inside the paragraph being read holds too.
 */
export class TranscriptReaderLine {
  private mark: TranscriptReaderMark | null = null;
  private settling = false;

  constructor(
    private readonly host: {
      readonly scrollElement: HTMLDivElement | null;
      readonly updateComplete: Promise<unknown>;
    },
    private readonly virtualizer: () => Virtualizer<HTMLDivElement, HTMLElement>,
    private readonly following: () => boolean,
    private readonly touching: () => boolean,
  ) {}

  /** Record the line on every offset change; a pending settle owns the old one. */
  record(): void {
    if (!this.settling) {
      this.mark = captureTranscriptReaderMark(this.host.scrollElement, this.following());
    }
  }

  readonly shouldAdjust = (
    item: VirtualItem,
    delta: number,
    virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  ): boolean => {
    const following = this.following();
    const shift = this.mark ? transcriptReaderMarkShift(this.mark, item.key) : null;
    if (shift !== null && shift !== 0 && !following) {
      this.settle();
    }
    return shouldCompensateTranscriptRowResize(item, virtualizer, following, delta, shift);
  };

  private settle(): void {
    // Writing scrollTop mid-touch cancels the gesture; the reader is moving it anyway.
    if (this.settling || this.touching()) {
      return;
    }
    this.settling = true;
    void this.host.updateComplete.then(() => {
      this.settling = false;
      const mark = this.mark;
      const element = this.host.scrollElement;
      const top = mark?.row.isConnected ? mark.measure() : null;
      if (!mark || !element || top === null || this.following() || Math.abs(top - mark.top) <= 1) {
        return;
      }
      this.virtualizer().scrollToOffset(element.scrollTop + top - mark.top, {
        behavior: "instant",
      });
    });
  }
}

/**
 * Whether a row payload changed at or above the viewport's end. Growth below
 * it (the reply streaming at the end) cannot move the reader.
 */
export function transcriptRowsChangedInView(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  items: readonly unknown[],
  previous: readonly unknown[],
): boolean {
  const index = items.findIndex((item, row) => item !== previous[row]);
  return (
    index >= 0 &&
    (virtualizer.measurementsCache[index]?.start ?? 0) <
      (virtualizer.scrollOffset ?? 0) + (virtualizer.scrollRect?.height ?? 0)
  );
}

export function maxTranscriptScrollOffset(element: HTMLElement | null): number | null {
  return element && element.clientHeight > 0
    ? Math.max(0, element.scrollHeight - element.clientHeight)
    : null;
}

export function reconcileInitialTranscriptOffset(
  element: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): "pending" | "settled" | "corrected" {
  const maxOffset = maxTranscriptScrollOffset(element);
  const offset = virtualizer.scrollOffset;
  if (maxOffset === null || offset === null) {
    return "pending";
  }
  if (offset >= 0 && offset <= maxOffset) {
    return "settled";
  }
  if (maxOffset !== 0) {
    return "pending";
  }
  // An underfilled end anchor clamps to zero without a native scroll event.
  virtualizer.scrollOffset = 0;
  virtualizer.scrollToOffset(0);
  return "corrected";
}

export class PositionRailGutterController implements ReactiveController {
  private resizeObserver: ResizeObserver | null = null;
  private viewport: HTMLDivElement | null = null;
  private innerElement: HTMLDivElement | null = null;
  private region: HTMLElement | null = null;

  constructor(
    private readonly host: ReactiveControllerHost & {
      readonly scrollElement: HTMLDivElement | null;
    },
    private readonly inner: () => HTMLDivElement | null,
  ) {
    host.addController(this);
  }

  hostUpdated(): void {
    const viewport = this.host.scrollElement;
    const inner = this.inner();
    const region = viewport?.closest<HTMLElement>(".chat-main__conversation") ?? viewport;
    if (viewport === this.viewport && inner === this.innerElement && region === this.region) {
      return;
    }
    this.hostDisconnected();
    if (!viewport?.isConnected || inner?.parentElement !== viewport || !region) {
      return;
    }
    this.viewport = viewport;
    this.innerElement = inner;
    this.region = region;
    const column = inner.querySelector<HTMLElement>(":scope > .chat-virtual-sizer") ?? inner;
    let innerWidth: number | undefined;
    let regionHeight: number | undefined;
    this.resizeObserver = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        if (entry.target === column) {
          const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
          changed ||= width !== innerWidth;
          innerWidth = width;
        } else if (entry.target === region) {
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          changed ||= height !== regionHeight;
          regionHeight = height;
        }
      }
      if (changed) {
        this.sync();
      }
    });
    // The virtual column has no flow height. Observing the owned range instead
    // feeds row measurements back into shallower ResizeObserver delivery.
    this.resizeObserver.observe(column, { box: "border-box" });
    this.resizeObserver.observe(region, { box: "border-box" });
  }

  hostDisconnected(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.viewport = null;
    this.innerElement = null;
    this.region = null;
  }

  read() {
    const viewport = this.host.scrollElement;
    const inner = this.inner();
    if (!viewport?.isConnected || inner?.parentElement !== viewport) {
      return null;
    }
    const left = viewport.getBoundingClientRect().left + viewport.clientLeft;
    const gutter = inner.getBoundingClientRect().left - left;
    // Publish the resolved, unscaled column width: a saved percentage cannot be
    // reused inside a descendant table without changing its containing block.
    const columnWidth = inner.clientWidth;
    const region = viewport.closest<HTMLElement>(".chat-main__conversation") ?? viewport;
    return { viewport, gutter, columnWidth, regionHeight: region.clientHeight };
  }

  sync(geometry = this.read()): void {
    if (!geometry) {
      return;
    }
    const { viewport, gutter, columnWidth, regionHeight } = geometry;
    if (columnWidth > 0) {
      viewport.style.setProperty("--chat-transcript-column-width", `${columnWidth}px`);
    }
    // The conversation region stays fixed when its composer resizes the scrollport.
    viewport.style.setProperty("--chat-position-rail-viewport-height", `${regionHeight}px`);
    // Reserve room for the compact left rail and breathing space, including
    // when a saved width fills the pane.
    viewport.toggleAttribute("data-position-rail-gutter", gutter >= 68);
  }
}
