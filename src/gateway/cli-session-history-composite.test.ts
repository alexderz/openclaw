import { describe, expect, it } from "vitest";
import {
  canRetireCompositeReply,
  findBoundedCompositeProof,
  isInternalUserMessage,
  isTextOnlyMessage,
} from "./cli-session-history-composite.js";

const rows = (texts: string[]) =>
  texts.map((text, importId) => ({ importId, displayRowId: importId, turnStartImportId: 0, text }));

describe("bounded composite proof", () => {
  it("finds a unique exact chain while skipping narration", () => {
    expect(
      findBoundedCompositeProof({
        localText: "first\nsecond",
        rows: rows(["first", "narration", "second"]),
        endImportId: 2,
        maxStates: 4096,
      }),
    ).toEqual({ kind: "unique", segments: [0, 2] });
  });
  it("keeps an ambiguous chain and a chain exceeding the search budget", () => {
    const input = { localText: "a b", rows: rows(["a", "a", "b"]), endImportId: 2 };
    expect(findBoundedCompositeProof({ ...input, maxStates: 4096 })).toEqual({ kind: "ambiguous" });
    expect(findBoundedCompositeProof({ ...input, maxStates: 1 })).toEqual({ kind: "limit" });
  });
  it("fails open when a matching chain exceeds the segment budget", () => {
    const input = rows(Array.from({ length: 33 }, () => "a"));
    expect(findBoundedCompositeProof({ localText: Array(33).fill("a").join(" "), rows: input, endImportId: 32, maxStates: 4096 })).toEqual({ kind: "limit" });
  });
  it("does not prove partial text or a one-segment result", () => {
    expect(
      findBoundedCompositeProof({
        localText: "extra a b",
        rows: rows(["a", "b"]),
        endImportId: 1,
        maxStates: 4096,
      }),
    ).toEqual({ kind: "none" });
    expect(
      findBoundedCompositeProof({
        localText: "b",
        rows: rows(["b"]),
        endImportId: 0,
        maxStates: 4096,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("conservative composite eligibility", () => {
  const local = { role: "assistant", provider: "claude-cli", api: "cli", content: "a b" };
  it("requires affirmative, noncontradictory source provenance", () => {
    expect(canRetireCompositeReply(local, "s1")).toBe(true);
    expect(canRetireCompositeReply({ role: "assistant", content: "a b" }, "s1")).toBe(false);
    expect(canRetireCompositeReply({ ...local, __openclaw: { cliSessionId: "s2" } }, "s1")).toBe(
      false,
    );
  });
  it("does not discard media or unknown content", () => {
    expect(isTextOnlyMessage({ ...local, content: "a\nMEDIA: /tmp/file" })).toBe(false);
    expect(isTextOnlyMessage({ ...local, content: [{ type: "tool_use", text: "a" }] })).toBe(false);
  });
  it("distinguishes internal tool results from operator prompts", () => {
    expect(isInternalUserMessage({ role: "user", content: [{ type: "tool_result" }] })).toBe(true);
    expect(isInternalUserMessage({ role: "user", content: [{ type: "image" }] })).toBe(false);
    expect(isInternalUserMessage({ role: "user", content: [] })).toBe(false);
  });
});
