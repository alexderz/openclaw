import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../../config/sessions/types.js";

const mocks = vi.hoisted(() => ({ live: vi.fn() }));
vi.mock("../../infra/agent-run-registry.js", () => ({ hasLiveAgentRunContext: mocks.live }));

import { probeSessionEntryObligations } from "./sessions-promotion-entry-obligations.js";

const quiet: InternalSessionEntry = { sessionId: "session", updatedAt: 1 };
const codes = (entry: InternalSessionEntry | undefined) =>
  probeSessionEntryObligations(entry).map((blocker) => blocker.code);

beforeEach(() => {
  mocks.live.mockReset().mockReturnValue(false);
});

describe("durable session-row obligations", () => {
  it("reports nothing for a quiet row, a finished recovery receipt and a stale writer id", () => {
    expect(codes(quiet)).toEqual([]);
    expect(codes({ ...quiet, restartRecoveryDeliveryReceiptState: "delivered-terminal" })).toEqual(
      [],
    );
    expect(codes({ ...quiet, activeWriterRunId: "run-finished" })).toEqual([]);
    expect(codes({ ...quiet, pendingDeliveryNotice: acknowledged() })).toEqual([]);
    expect(codes({ ...quiet, abortedLastRun: true, status: "killed" })).toEqual([]);
  });
  it("treats a missing or unreadable row as a blocker, never as quiet", () => {
    expect(codes(undefined)).toEqual(["session-row-unavailable"]);
    const hostile = new Proxy(quiet, {
      get() {
        throw new Error("unreadable");
      },
      ownKeys() {
        throw new Error("unreadable");
      },
    });
    expect(codes(hostile)).toEqual(["session-row-unreadable"]);
  });
  it("blocks on a live transcript writer but not on a persisted id alone", () => {
    mocks.live.mockReturnValue(true);
    expect(codes({ ...quiet, activeWriterRunId: "run-live" })).toEqual(["transcript-writer-live"]);
    expect(mocks.live).toHaveBeenCalledWith("run-live");
  });
  it.each([
    ["pending-final-delivery", { pendingFinalDelivery: { kind: "transport-only", createdAt: 1 } }],
    ["pending-transcript-repair", { pendingTranscriptRepair: [{}] }],
    ["restart-recovery", { restartRecoveryDeliveryReceiptState: "terminal-pending" }],
    ["restart-recovery", { restartRecoveryHarnessCompletion: {} }],
    ["restart-recovery", { restartRecoveryTerminalRunIds: ["run"] }],
    ["restart-recovery", { someFutureField: 1, restartRecoverySomethingNew: true }],
    ["interrupted-run-awaiting-recovery", { abortedLastRun: true, status: "running" }],
    ["lifecycle-run-open", { lifecycleRunId: "run" }],
  ] as Array<[string, object]>)("blocks on %s", (code, patch) => {
    expect(codes({ ...quiet, ...patch } as InternalSessionEntry)).toContain(code);
  });
});

function acknowledged() {
  return { createdAt: 1, context: {}, intentId: "i", state: "acknowledged" as const };
}
