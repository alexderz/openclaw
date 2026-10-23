import { describe, expect, it, vi } from "vitest";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  markSubagentChildHandedOff,
  subagentRunOwnsChildSession,
} from "./subagent-registry-child-handoff.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("./subagent-registry-persistence.js", () => ({
  // Model the registry writer: plan against the resident rows, publish the postimages.
  mutateSubagentRuns: vi.fn(
    async (
      runIds: readonly string[],
      plan: (rows: ReadonlyMap<string, SubagentRunRecord>) => {
        value: unknown;
        postimages?: ReadonlyMap<string, SubagentRunRecord | null>;
      },
      options: { runs: Map<string, SubagentRunRecord> },
    ) => {
      const rows = new Map(
        runIds.flatMap((id) => {
          const row = options.runs.get(id);
          return row ? [[id, row] as const] : [];
        }),
      );
      const planned = plan(rows);
      for (const [id, row] of planned.postimages ?? []) {
        if (row) {
          options.runs.set(id, row);
        }
      }
      return planned.value;
    },
  ),
}));

const PARENT = "agent:main:dashboard:parent";
const PROMOTED = "agent:main:dashboard:promoted";
const GRANDCHILD = "agent:main:subagent:grandchild";

function run(overrides: Partial<SubagentRunRecordOverrides> & { runId: string }) {
  return createSubagentRunRecord({
    requesterDisplayKey: "synthetic",
    task: "synthetic",
    cleanup: "keep",
    createdAt: 1,
    ...overrides,
  } as SubagentRunRecordOverrides);
}

/** A run whose every durable obligation has settled. */
function settledRun(overrides: Partial<SubagentRunRecordOverrides> & { runId: string }) {
  return run({
    endedAt: 2,
    startedAt: 1,
    outcome: { status: "ok" },
    cleanupCompletedAt: 3,
    expectsCompletionMessage: true,
    ...overrides,
    delivery: { status: "delivered" },
  } as never);
}

function fixture() {
  const spawn = settledRun({
    runId: "spawn",
    childSessionKey: PROMOTED,
    requesterSessionKey: PARENT,
  });
  const wake = settledRun({
    runId: "announce:requester-settle:wake",
    childSessionKey: PROMOTED,
    requesterSessionKey: PARENT,
  });
  // Work the promoted session started itself, ended but not yet cleaned up.
  const own = run({
    runId: "own",
    childSessionKey: GRANDCHILD,
    requesterSessionKey: PROMOTED,
    endedAt: 5,
    startedAt: 4,
    outcome: { status: "ok" },
  } as never);
  return new Map([spawn, wake, own].map((row) => [row.runId, row]));
}

describe("promoted child handoff in the subagent registry", () => {
  it("cuts the former parent's subtree at the handed-off edge, and only there", async () => {
    const runs = fixture();
    const before = buildSubagentRunReadIndexFromRuns({ runs, now: 10 });
    expect(before.countPendingDescendantRuns(PARENT)).toBe(1);
    expect(before.listDescendantRunsForRequester(PARENT).map((row) => row.runId)).toContain("own");

    const result = await markSubagentChildHandedOff({
      runs,
      childSessionKey: PROMOTED,
      childSessionId: "promoted-session",
      at: 9,
    });
    expect(result).toEqual({ marked: 2, unsettled: 0 });
    expect(runs.get("spawn")?.childHandoff).toEqual({
      kind: "session-promoted",
      at: 9,
      childSessionId: "promoted-session",
    });
    // History is otherwise untouched; the promoted session's own rows are not edges to mark.
    expect(runs.get("spawn")).toMatchObject({ requesterSessionKey: PARENT, cleanupCompletedAt: 3 });
    expect(runs.get("own")?.childHandoff).toBeUndefined();

    const after = buildSubagentRunReadIndexFromRuns({ runs, now: 10 });
    expect(after.countPendingDescendantRuns(PARENT)).toBe(0);
    expect(after.countActiveDescendantRuns(PARENT)).toBe(0);
    expect(after.hasDescendantRunAwaitingSettle(PARENT)).toBe(false);
    expect(after.listDescendantRunsForRequester(PARENT)).toEqual([]);
    // The promoted root still owns and waits on its own work.
    expect(after.countPendingDescendantRuns(PROMOTED)).toBe(1);
    expect(after.listDescendantRunsForRequester(PROMOTED).map((row) => row.runId)).toEqual(["own"]);

    // Idempotent.
    expect(await markSubagentChildHandedOff({ runs, childSessionKey: PROMOTED, at: 99 })).toEqual({
      marked: 0,
      unsettled: 0,
    });
    expect(runs.get("spawn")?.childHandoff?.at).toBe(9);
  });

  it("never marks a spawner run that still owes an effect", async () => {
    const runs = fixture();
    const pending = run({
      runId: "pending-delivery",
      childSessionKey: PROMOTED,
      requesterSessionKey: PARENT,
      endedAt: 2,
      startedAt: 1,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
    } as never);
    runs.set(pending.runId, pending);
    expect(await markSubagentChildHandedOff({ runs, childSessionKey: PROMOTED, at: 9 })).toEqual({
      marked: 2,
      unsettled: 1,
    });
    expect(runs.get("pending-delivery")?.childHandoff).toBeUndefined();
  });

  it("names the controller only while the registry still owns the child session", () => {
    const settled = {
      childHandoff: undefined,
      execution: { status: "terminal" as const, endedAt: 2 },
    };
    const running = { childHandoff: undefined, execution: { status: "running" as const } };
    const handedOff = { ...settled, childHandoff: { kind: "session-promoted" as const, at: 3 } };
    const spawned = { spawnedBy: PARENT, spawnDepth: 1, createdVia: "spawn" };
    // Molting shape: an operator-created root whose settled initial-task run names Home.
    const operatorRoot = { createdVia: "operator", spawnDepth: 0 };
    const promotedRoot = { createdVia: "spawn", spawnDepth: 0, promotedFrom: { version: 1 } };
    expect(subagentRunOwnsChildSession(settled, spawned)).toBe(true);
    expect(subagentRunOwnsChildSession(settled, operatorRoot)).toBe(false);
    expect(subagentRunOwnsChildSession(settled, promotedRoot)).toBe(false);
    expect(subagentRunOwnsChildSession(running, operatorRoot)).toBe(true);
    expect(subagentRunOwnsChildSession(settled, undefined)).toBe(true);
    expect(subagentRunOwnsChildSession(handedOff, spawned)).toBe(false);
    expect(subagentRunOwnsChildSession(handedOff, undefined)).toBe(false);
    expect(subagentRunOwnsChildSession(null, spawned)).toBe(false);
    // A legacy root without a creation stamp keeps today's registry projection.
    expect(subagentRunOwnsChildSession(settled, { spawnDepth: 0 })).toBe(true);
  });
});
