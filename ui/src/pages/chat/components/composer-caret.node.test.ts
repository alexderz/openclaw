import { describe, expect, it } from "vitest";
import { activeCaretOffset, scrollTopForCaretLine } from "./composer-caret.ts";

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
