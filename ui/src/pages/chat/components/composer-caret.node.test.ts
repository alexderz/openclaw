import { describe, expect, it } from "vitest";
import { scrollTopForCaretLine } from "./composer-caret.ts";

describe("scrollTopForCaretLine", () => {
  it("scrolls a wrapped caret line into the textarea without moving upward when it already fits", () => {
    expect(
      scrollTopForCaretLine({
        scrollTop: 0,
        scrollHeight: 76,
        clientHeight: 32,
        caretTop: 48,
        caretBottom: 72,
      }),
    ).toBe(40);
    expect(
      scrollTopForCaretLine({
        scrollTop: 40,
        scrollHeight: 76,
        clientHeight: 32,
        caretTop: 48,
        caretBottom: 72,
      }),
    ).toBe(40);
  });

  it("scrolls up when the caret moves above the visible line and never past the draft", () => {
    expect(
      scrollTopForCaretLine({
        scrollTop: 40,
        scrollHeight: 76,
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
        caretTop: 48,
        caretBottom: 72,
      }),
    ).toBe(0);
  });
});
