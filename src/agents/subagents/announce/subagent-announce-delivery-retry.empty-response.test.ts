import { describe, expect, it } from "vitest";
import { isIncompleteAnnounceAgentResultError } from "./subagent-announce-delivery-retry.js";

describe("CLI completion wake empty response", () => {
  it("recognizes typed empty_response without relying on its message", () => {
    expect(
      isIncompleteAnnounceAgentResultError(
        Object.assign(new Error("backend failed"), { reason: "empty_response" }),
      ),
    ).toBe(true);
  });
  it("recognizes serialized CLI diagnostics", () => {
    expect(
      isIncompleteAnnounceAgentResultError(
        new Error("CLI backend returned an empty response (backend=claude-cli)."),
      ),
    ).toBe(true);
  });
  it("preserves existing incomplete and unrelated classifications", () => {
    expect(isIncompleteAnnounceAgentResultError(new Error("incomplete terminal response"))).toBe(
      true,
    );
    expect(isIncompleteAnnounceAgentResultError(new Error("code=incomplete_result"))).toBe(true);
    expect(isIncompleteAnnounceAgentResultError(new Error("gateway timeout"))).toBe(false);
  });
});
