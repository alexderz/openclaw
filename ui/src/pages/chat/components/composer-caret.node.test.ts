import { describe, expect, it } from "vitest";
import {
  activeCaretOffset,
  scrollTopForCaretLine,
  shouldFollowCaret,
  shouldRevealOnViewportResize,
  viewportPanDelta,
} from "./composer-caret.ts";

describe("activeCaretOffset", () => {
  it("uses the active end and does not imply the selection should be rewritten", () => {
    expect(
      activeCaretOffset({ start: 4, end: 20, direction: "forward", valueLength: 40 }),
    ).toBe(20);
    expect(
      activeCaretOffset({ start: 4, end: 20, direction: "backward", valueLength: 40 }),
    ).toBe(4);
    expect(activeCaretOffset({ start: 11, end: 11, direction: "none", valueLength: 40 })).toBe(
      11,
    );
    expect(activeCaretOffset({ start: null, end: null, direction: null, valueLength: 8 })).toBe(
      8,
    );
  });
});

describe("passive caret events", () => {
  it("does not follow an unchanged selection or a reading viewport resize", () => {
    expect(shouldFollowCaret(20, 20)).toBe(false);
    expect(shouldFollowCaret(20, 21)).toBe(true);
    expect(shouldFollowCaret(null, 20)).toBe(true);
    expect(shouldRevealOnViewportResize(true, false)).toBe(false);
    expect(shouldRevealOnViewportResize(false, false)).toBe(true);
    expect(shouldRevealOnViewportResize(true, true)).toBe(true);
  });

  it("restores a captured nonzero visual-viewport offset instead of forcing 0", () => {
    expect(
      viewportPanDelta({ offsetTop: 30, offsetLeft: 4 }, { offsetTop: 12, offsetLeft: 4 }),
    ).toEqual({ dx: 0, dy: 18 });
    expect(
      viewportPanDelta({ offsetTop: 12, offsetLeft: 4 }, { offsetTop: 12, offsetLeft: 4 }),
    ).toEqual({ dx: 0, dy: 0 });
  });
});

describe("scrollTopForCaretLine", () => {
  it("scrolls a wrapped caret into the textarea and leaves an in-range offset alone", () => {
    expect(
      scrollTopForCaretLine({
        scrollTop: 0,
        scrollHeight: 200,
        clientHeight: 32,
        caretTop: 96,
        caretBottom: 120,
      }),
    ).toBe(88);
    expect(
      scrollTopForCaretLine({
        scrollTop: 88,
        scrollHeight: 200,
        clientHeight: 32,
        caretTop: 96,
        caretBottom: 120,
      }),
    ).toBe(88);
  });

  it("scrolls up for a caret above the window and never past the draft", () => {
    expect(
      scrollTopForCaretLine({
        scrollTop: 88,
        scrollHeight: 200,
        clientHeight: 32,
        caretTop: 0,
        caretBottom: 24,
      }),
    ).toBe(0);
    expect(
      scrollTopForCaretLine({
        scrollTop: 0,
        scrollHeight: 32,
        clientHeight: 32,
        caretTop: 80,
        caretBottom: 104,
      }),
    ).toBe(0);
  });
});
