import { beforeEach, describe, expect, it, vi } from "vitest";

const owners = vi.hoisted(() => ({
  admissions: vi.fn(),
  phases: vi.fn(),
  cliCustody: vi.fn(),
  replies: vi.fn(),
  embedded: vi.fn(),
  queues: vi.fn(),
  runs: vi.fn(),
  media: vi.fn(),
  processes: vi.fn(),
  finished: vi.fn(),
  poll: vi.fn(),
  abort: vi.fn(),
  worker: vi.fn(),
  snapshot: vi.fn(),
  lane: vi.fn(),
  resolveStore: vi.fn(),
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  resolveSessionEntryAccessTarget: owners.resolveStore,
}));
vi.mock("../../sessions/session-lifecycle-admission.js", () => ({
  isSessionWorkAdmissionActive: owners.admissions,
  inspectSessionWorkAdmissionPhases: owners.phases,
}));
vi.mock("../../agents/cli-runner/cli-live-session-registry.js", () => ({
  hasCliSessionLifecycleCustody: owners.cliCustody,
}));
vi.mock("../../auto-reply/reply/reply-run-registry.js", () => ({
  resolveReplyOperationsForSession: owners.replies,
}));
vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  isEmbeddedAgentRunInProgress: owners.embedded,
}));
vi.mock("../../auto-reply/reply/queue/cleanup.js", () => ({
  hasSessionLifecycleQueueWork: owners.queues,
}));
vi.mock("../../process/command-queue.js", () => ({ getCommandLaneSnapshot: owners.lane }));
vi.mock("../../infra/agent-run-registry.js", () => ({ listAgentRunsForSession: owners.runs }));
vi.mock("../../agents/media-generation-activity.js", () => ({
  buildPendingGeneratedMediaSessionKeySet: owners.media,
}));
vi.mock("../../agents/bash-process-registry.js", () => ({
  listRunningSessions: owners.processes,
  listFinishedSessions: owners.finished,
  hasPendingPollDelivery: owners.poll,
}));
vi.mock("./chat-abort-authorization.js", () => ({ hasGatewaySessionAbortOwner: owners.abort }));
vi.mock("../worker-environments/inference-control-internal.js", () => ({
  getWorkerInferenceSessionControl: owners.worker,
}));
vi.mock("../../agents/subagents/registry/subagent-registry-memory.js", () => ({
  subagentRuns: new Map(),
}));
vi.mock("../../agents/subagents/registry/subagent-registry-state.js", () => ({
  withSubagentRunReadSnapshot: owners.snapshot,
}));

import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import {
  probeSessionPromotionQuiescence,
  type SessionPromotionProbeParams,
} from "./sessions-promotion-quiescence.js";

const probeSessionPromotionBlockers = async (input: SessionPromotionProbeParams) =>
  (await probeSessionPromotionQuiescence(input)).blockers;

/** A readable worker-placement owner with no claims, results, or reconciliations. */
function quietPlacements() {
  return {
    getMany: vi.fn(() => new Map()),
    listPendingWorkspaceResultsAsync: vi.fn(async () => []),
    getWorkspaceResultReconcilingSessionIdsAsync: vi.fn(async () => new Set()),
  } as unknown as NonNullable<
    SessionPromotionProbeParams["context"]["workerSessionPlacementService"]
  >;
}

function params(): SessionPromotionProbeParams {
  return {
    context: {
      chatAbortControllers: new Map(),
      dedupe: new Map(),
      workerSessionPlacementService: quietPlacements(),
    } as unknown as SessionPromotionProbeParams["context"],
    storePath: "/test/store",
    sessionKey: "agent:main:subagent:target",
    sessionKeys: ["agent:main:subagent:target", "alias"],
    sessionId: "target-id",
    agentId: "main",
    lifecycleIdentities: ["target-id", "alias"],
  };
}
async function codes(input = params()) {
  return (await probeSessionPromotionBlockers(input)).map((blocker) => blocker.code);
}

describe("probeSessionPromotionQuiescence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    subagentRuns.clear();
    owners.replies.mockReturnValue([]);
    owners.runs.mockReturnValue([]);
    owners.phases.mockReturnValue({ pending: 0, acquired: 0 });
    owners.cliCustody.mockReturnValue(false);
    owners.lane.mockReturnValue({ activeCount: 0 });
    owners.media.mockReturnValue(new Set());
    owners.processes.mockReturnValue([]);
    owners.finished.mockReturnValue([]);
    owners.snapshot.mockImplementation(async (_memory, select, consume) => {
      const rows = new Map();
      return consume(select(rows), rows);
    });
    owners.resolveStore.mockImplementation((scope: { agentId: string; sessionKey: string }) => ({
      storePath: `/test/store/${scope.agentId}`,
      canonicalKey: scope.sessionKey,
      storeKey: scope.sessionKey,
      storeKeys: [scope.sessionKey],
    }));
  });
  it("never treats an unreadable pending-admission or CLI custody owner as quiescence", async () => {
    owners.phases.mockImplementation(() => {
      throw new Error("unavailable");
    });
    owners.cliCustody.mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(await codes()).toContain("inventory-unavailable");
  });
  it.each([
    ["admissions", true, "admission"],
    ["replies", [{}], "reply"],
    ["embedded", true, "embedded"],
    ["queues", true, "queue"],
    ["runs", [{ runId: "old" }], "run"],
    ["abort", true, "gateway-input"],
    ["media", new Set(["alias"]), "task"],
  ] as const)("reports %s without interrupting its owner", async (owner, value, code) => {
    owners[owner].mockReturnValue(value);
    expect(await codes()).toContain(code);
  });
  it("checks all identity aliases and active lane tasks", async () => {
    owners.queues.mockImplementation(({ keys }) => keys.includes("alias"));
    expect(await codes()).toContain("queue");
    expect(owners.admissions).toHaveBeenCalledWith(
      "/test/store",
      expect.arrayContaining(["alias", "target-id"]),
    );
  });
  it("blocks active lane tasks even with an empty queued inventory", async () => {
    owners.lane.mockReturnValue({ activeCount: 1 });
    expect(await codes()).toContain("queue");
  });
  it("checks incarnation-keyed lanes as well as key aliases", async () => {
    owners.lane.mockImplementation((lane) => ({
      activeCount: lane === "session:target-id" ? 1 : 0,
    }));
    expect(await codes()).toContain("queue");
  });
  it("retains finished process delivery custody and ignores unrelated tasks", async () => {
    owners.finished.mockReturnValue([{ id: "p", sessionKey: "alias", agentId: "main" }]);
    owners.poll.mockReturnValue(true);
    expect(await codes()).toContain("process-delivery");
    owners.finished.mockReturnValue([{ id: "p", sessionKey: "unrelated", agentId: "main" }]);
    expect(await codes()).not.toContain("process-delivery");
  });
  it("blocks worker claims, inference, and unacknowledged workspace results", async () => {
    const input = params();
    input.context.workerSessionPlacementService = {
      getMany: vi.fn(() => new Map([["target-id", { turnClaim: {} }]])),
      listPendingWorkspaceResultsAsync: vi.fn(async () => [{}]),
      getWorkspaceResultReconcilingSessionIdsAsync: vi.fn(async () => new Set(["target-id"])),
    } as unknown as NonNullable<typeof input.context.workerSessionPlacementService>;
    input.context.workerEnvironmentService = {} as NonNullable<
      typeof input.context.workerEnvironmentService
    >;
    owners.worker.mockReturnValue({ hasSession: () => true });
    expect(await codes(input)).toEqual(
      expect.arrayContaining([
        "worker-claim",
        "worker-inference",
        "worker-result",
        "worker-reconciliation",
      ]),
    );
  });
  it("does not begin a terminal drain to inspect hidden pending/exiting work", async () => {
    const input = params();
    const drain = vi.fn(() => {
      throw new Error("destructive");
    });
    input.context.terminalSessions = { beginAgentSessionDrain: drain } as unknown as NonNullable<
      typeof input.context.terminalSessions
    >;
    expect(await codes(input)).toContain("terminal-inventory-unavailable");
    expect(drain).not.toHaveBeenCalled();
  });
  it("blocks ended self/parent custody and transitive descendant obligations", async () => {
    const rows = new Map([
      [
        "self",
        {
          runId: "self",
          requesterSessionKey: "parent",
          childSessionKey: params().sessionKey,
          endedAt: 1,
          cleanupCompletedAt: 2,
        },
      ],
      [
        "child",
        {
          runId: "child",
          requesterSessionKey: params().sessionKey,
          childSessionKey: "child-key",
          endedAt: 1,
        },
      ],
      [
        "grandchild",
        {
          runId: "grandchild",
          requesterSessionKey: "child-key",
          childSessionKey: "grandchild-key",
          killReconciliation: {},
        },
      ],
      [
        "unrelated",
        { runId: "unrelated", requesterSessionKey: "other", childSessionKey: "other-child" },
      ],
    ]);
    owners.snapshot.mockImplementation(async (_memory, select, consume) =>
      consume(select(rows), rows),
    );
    const result = await probeSessionPromotionBlockers(params());
    expect(result.filter((b) => b.code === "delegation-custody").map((b) => b.runId)).toEqual([
      "self",
      "child",
      "grandchild",
    ]);
    expect(owners.queues).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "grandchild-key" }),
    );
  });
  it("fails closed when an owner inventory throws instead of rejecting or allowing activation", async () => {
    owners.snapshot.mockRejectedValue(new Error("unavailable"));
    owners.replies.mockImplementation(() => {
      throw new Error("stale");
    });
    expect(await codes()).toEqual(expect.arrayContaining(["inventory-unavailable"]));
  });
  it("returns an empty inventory only when all authoritative owners are quiet", async () => {
    expect(await codes()).toEqual([]);
  });
  it("fails closed when the authoritative probe has no worker placement owner to read", async () => {
    const input = params();
    delete input.context.workerSessionPlacementService;
    // One blocker per root alias; nothing else is reported for an otherwise quiet session.
    expect(new Set(await codes(input))).toEqual(new Set(["worker-result-inventory-unavailable"]));
    // The advisory pre-check never makes the asynchronous worker reads.
    expect(await codes({ ...input, quick: true })).toEqual([]);
  });
  it("blocks pending inputs, live CLI custody and pending or exiting terminals", async () => {
    owners.phases.mockReturnValue({ pending: 1, acquired: 0 });
    owners.cliCustody.mockReturnValue(true);
    const p = params();
    p.context.terminalSessions = {
      inspectAgentSessionWork: () => true,
    } as unknown as typeof p.context.terminalSessions;
    const found = await codes(p);
    expect(found).toContain("pending-admission");
    expect(found).toContain("cli-session-custody");
    expect(found).toContain("agent-terminal-custody");
  });

  it("reads pending and acquired admissions in each descendant's own agent store, not only the root's", async () => {
    const rows = new Map([
      [
        "child",
        {
          runId: "child",
          requesterSessionKey: params().sessionKey,
          childSessionKey: "agent:worker:dashboard:child",
          childAgentId: "worker",
          childSessionIdentity: { sessionId: "child-id" },
        },
      ],
    ]);
    owners.snapshot.mockImplementation(async (_memory, select, consume) =>
      consume(select(rows), rows),
    );
    owners.phases.mockImplementation((storePath: string) =>
      storePath === "/test/store/worker"
        ? { pending: 1, acquired: 0 }
        : { pending: 0, acquired: 0 },
    );
    const result = await probeSessionPromotionBlockers({
      ...params(),
      context: {
        ...params().context,
        getRuntimeConfig: () => ({}),
      } as unknown as SessionPromotionProbeParams["context"],
    });
    expect(result.filter((b) => b.code === "pending-admission").map((b) => b.sessionKey)).toEqual([
      "agent:worker:dashboard:child",
    ]);
    expect(owners.phases).toHaveBeenCalledWith(
      "/test/store/worker",
      expect.arrayContaining(["agent:worker:dashboard:child", "child-id"]),
    );
  });
  it("fails closed when a descendant's agent store cannot be resolved", async () => {
    const rows = new Map([
      [
        "child",
        {
          runId: "child",
          requesterSessionKey: params().sessionKey,
          childSessionKey: "agent:worker:dashboard:child",
          childAgentId: "worker",
        },
      ],
    ]);
    owners.snapshot.mockImplementation(async (_memory, select, consume) =>
      consume(select(rows), rows),
    );
    owners.resolveStore.mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(await codes()).toContain("inventory-unavailable");
  });

  it("does not block on a retained, fully settled historical run for the target", async () => {
    const rows = new Map([
      [
        "self",
        {
          runId: "self",
          requesterSessionKey: "parent",
          childSessionKey: params().sessionKey,
          cleanupCompletedAt: 2,
          expectsCompletionMessage: true,
          execution: { status: "terminal", endedAt: 1 },
          delivery: { status: "delivered" },
        },
      ],
    ]);
    owners.snapshot.mockImplementation(async (_memory, select, consume) =>
      consume(select(rows), rows),
    );
    expect(await codes()).toEqual([]);
    rows.get("self")!.delivery = { status: "in_progress" };
    expect(await codes()).toContain("delegation-custody");
  });
  it("re-reads every synchronous owner at the commit, so work that appeared after the probe still blocks", async () => {
    const probe = await probeSessionPromotionQuiescence(params());
    expect(probe.blockers).toEqual([]);
    expect(probe.recheck()).toEqual([]);
    owners.phases.mockReturnValue({ pending: 1, acquired: 0 });
    owners.queues.mockReturnValue(true);
    owners.abort.mockReturnValue(true);
    expect(probe.recheck().map((b) => b.code)).toEqual(
      expect.arrayContaining(["pending-admission", "queue", "gateway-input"]),
    );
  });
  it("re-check sees a delegation started after the persisted snapshot, from the live registry", async () => {
    const probe = await probeSessionPromotionQuiescence(params());
    subagentRuns.set("late", {
      runId: "late",
      requesterSessionKey: params().sessionKey,
      childSessionKey: "agent:main:subagent:late",
    } as never);
    expect(probe.recheck()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "delegation-custody", runId: "late" }),
      ]),
    );
  });
  it("extends the caller's reservation watch to each descendant in its own store", async () => {
    const rows = new Map([
      [
        "child",
        {
          runId: "child",
          requesterSessionKey: params().sessionKey,
          childSessionKey: "agent:worker:dashboard:child",
          childAgentId: "worker",
          childSessionIdentity: { sessionId: "child-id" },
        },
      ],
    ]);
    owners.snapshot.mockImplementation(async (_memory, select, consume) =>
      consume(select(rows), rows),
    );
    const watch = { add: vi.fn() };
    const probe = await probeSessionPromotionQuiescence({
      ...params(),
      context: {
        ...params().context,
        getRuntimeConfig: () => ({}),
      } as unknown as SessionPromotionProbeParams["context"],
      watch,
    });
    expect(watch.add).toHaveBeenCalledWith("/test/store/worker", [
      "agent:worker:dashboard:child",
      "child-id",
    ]);
    owners.phases.mockImplementation((storePath: string) =>
      storePath === "/test/store/worker"
        ? { pending: 0, acquired: 1 }
        : { pending: 0, acquired: 0 },
    );
    expect(probe.recheck()).toEqual([
      expect.objectContaining({ code: "admission", sessionKey: "agent:worker:dashboard:child" }),
    ]);
  });
  it("watches and re-checks a descendant under its store's canonical and physical aliases", async () => {
    const rows = new Map([
      [
        "child",
        {
          runId: "child",
          requesterSessionKey: params().sessionKey,
          childSessionKey: "agent:worker:Dashboard:Child",
          childAgentId: "worker",
          childSessionIdentity: { sessionId: "child-id" },
        },
      ],
    ]);
    owners.snapshot.mockImplementation(async (_memory, select, consume) =>
      consume(select(rows), rows),
    );
    owners.resolveStore.mockImplementation((scope: { agentId: string }) => ({
      storePath: `/test/store/${scope.agentId}`,
      canonicalKey: "agent:worker:dashboard:child",
      storeKey: "dashboard:child",
      storeKeys: ["dashboard:child", "agent:worker:dashboard:child"],
    }));
    const watch = { add: vi.fn() };
    const probe = await probeSessionPromotionQuiescence({
      ...params(),
      context: {
        ...params().context,
        getRuntimeConfig: () => ({}),
      } as unknown as SessionPromotionProbeParams["context"],
      watch,
    });
    const watched = new Set(watch.add.mock.calls.flatMap(([, ids]) => ids as string[]));
    expect(watched).toEqual(
      new Set([
        "agent:worker:Dashboard:Child",
        "child-id",
        "agent:worker:dashboard:child",
        "dashboard:child",
      ]),
    );
    // An admission reserved only under the physical store key is still the descendant's work.
    owners.phases.mockImplementation((storePath: string, identities: string[]) =>
      storePath === "/test/store/worker" && identities.includes("dashboard:child")
        ? { pending: 1, acquired: 0 }
        : { pending: 0, acquired: 0 },
    );
    expect(probe.recheck()).toEqual([
      expect.objectContaining({
        code: "pending-admission",
        sessionKey: "agent:worker:Dashboard:Child",
      }),
    ]);
  });
});
