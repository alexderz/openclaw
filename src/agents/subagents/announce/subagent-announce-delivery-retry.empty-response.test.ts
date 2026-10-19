import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../failover-error.js";
import {
  isIncompleteAnnounceAgentResultError,
  runAnnounceDeliveryWithRetry,
} from "./subagent-announce-delivery-retry.js";

function cliEmptyResponse() {
  return new FailoverError("CLI backend returned an empty response.", {
    reason: "empty_response",
    provider: "claude-cli",
    model: "claude-opus-4-7",
    attempts: [
      {
        provider: "claude-cli",
        model: "claude-opus-4-7",
        reason: "empty_response",
        error: "CLI backend returned an empty response.",
      },
    ],
  });
}

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

describe("CLI completion wake retry loop", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["typed", () => cliEmptyResponse()],
    ["wrapped", () => new Error("announce agent call failed", { cause: cliEmptyResponse() })],
  ])("does not replay a %s NO_REPLY empty_response wake", async (_name, build) => {
    const error = build();
    const run = vi.fn(async () => {
      throw error;
    });
    await expect(runAnnounceDeliveryWithRetry({ operation: "completion wake", run })).rejects.toBe(
      error,
    );
    expect(run).toHaveBeenCalledOnce();
    // Direct delivery selects its completed-result text fallback from this classifier.
    expect(
      isIncompleteAnnounceAgentResultError(error instanceof FailoverError ? error : error.cause),
    ).toBe(true);
  });

  it("keeps retrying real transient failures", async () => {
    const timeout = new FailoverError("All models failed (1): claude-cli: timed out", {
      reason: "timeout",
      provider: "claude-cli",
      model: "claude-opus-4-7",
      attempts: [{ provider: "claude-cli", model: "claude-opus-4-7", reason: "timeout" }],
    });
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce("delivered");
    await expect(runAnnounceDeliveryWithRetry({ operation: "completion wake", run })).resolves.toBe(
      "delivered",
    );
    expect(run).toHaveBeenCalledTimes(3);
  });
});
