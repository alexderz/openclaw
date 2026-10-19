import { describe, expect, it } from "vitest";
import { isSubagentRunLifecycleSettled } from "./subagent-delivery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function settled(overrides: Record<string, unknown> = {}): SubagentRunRecord {
  return {
    runId: "run",
    childSessionKey: "agent:main:dashboard:target",
    requesterSessionKey: "agent:main:main",
    cleanupCompletedAt: 2,
    expectsCompletionMessage: true,
    execution: { status: "terminal", endedAt: 1 },
    delivery: { status: "delivered" },
    ...overrides,
  } as unknown as SubagentRunRecord;
}

describe("isSubagentRunLifecycleSettled", () => {
  it("releases a fully delivered, cleaned-up, terminal run", () => {
    expect(isSubagentRunLifecycleSettled(settled())).toBe(true);
    expect(
      isSubagentRunLifecycleSettled(
        settled({ expectsCompletionMessage: false, delivery: undefined }),
      ),
    ).toBe(true);
    expect(
      isSubagentRunLifecycleSettled(
        settled({ delivery: { status: "discarded", discardReason: "expired" } }),
      ),
    ).toBe(true);
  });
  it.each([
    ["no cleanup timestamp", { cleanupCompletedAt: undefined }],
    ["running execution", { execution: { status: "running", endedAt: 1 } }],
    ["interrupted execution", { execution: { status: "interrupted", endedAt: 1 } }],
    ["no end time", { execution: { status: "terminal" } }],
    ["restart recovery", { execution: { status: "terminal", endedAt: 1, restartRecovery: {} } }],
    ["kill intent", { killIntent: {} }],
    ["kill reconciliation", { killReconciliation: {} }],
    ["queued launch", { queuedLaunch: {} }],
    ["pending launch", { swarmLaunchPending: true }],
    ["launch cleanup pending", { collectorLaunchCleanupPending: true }],
    ["collector result custody", { collectorCompletion: { status: "done" } }],
    ["requester settle wake", { requesterSettleWake: { status: "pending", attemptCount: 0 } }],
    ["interrupted-recovery owner", { terminalOwner: "interrupted-recovery" }],
    ["pending delivery", { delivery: { status: "pending", payload: {} } }],
    ["in-progress delivery", { delivery: { status: "in_progress", payload: {} } }],
    ["suspended delivery", { delivery: { status: "suspended", suspendedAt: 1, payload: {} } }],
    ["required delivery missing", { delivery: undefined }],
    ["legacy shape without execution", { execution: undefined }],
  ])("keeps %s unsettled", (_name, overrides) => {
    expect(isSubagentRunLifecycleSettled(settled(overrides))).toBe(false);
  });
});
