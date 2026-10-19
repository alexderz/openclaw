import { afterEach, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import * as deliveryRuntime from "../announce/subagent-announce-delivery.runtime.js";
import {
  createLifecycleControllerFixture,
  createRunEntry,
} from "./subagent-registry-lifecycle-controller.test-support.js";

vi.mock("../announce/subagent-announce-delivery.runtime.js", { spy: true });
vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeFromActiveBundles: vi.fn(async () => {}),
}));

afterEach(() => vi.restoreAllMocks());

function recordGatewayCalls() {
  const calls = vi.fn(async (_opts: CallGatewayOptions) => ({}));
  const callGateway = async <T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> =>
    (await calls(opts)) as T;
  return { calls, callGateway };
}

it("suppresses old delegated session effects after same-session authority revision changes", async () => {
  const entry = createRunEntry({
    childSessionIdentity: { sessionId: "same-conversation", lifecycleRevision: "delegated" },
  });
  vi.mocked(deliveryRuntime.loadSessionEntryByKey).mockResolvedValue({
    sessionId: "same-conversation",
    lifecycleRevision: "operator-handoff",
    updatedAt: 1,
  });
  const controller = createLifecycleControllerFixture(
    { entry },
    {
      callGateway: recordGatewayCalls().callGateway,
      cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
      ownersByEntry: new Map(),
    },
  );

  expect(await controller.shouldSuppressSessionEffects(entry)).toBe(true);
});

it.each([
  { name: "missing original custody", identity: undefined, deletions: 0 },
  {
    name: "matching original custody",
    identity: { sessionId: "current-conversation", lifecycleRevision: "original" },
    deletions: 1,
  },
])("cleanup deletion uses only $name", async ({ identity, deletions }) => {
  const entry = createRunEntry({
    cleanup: "delete",
    endedAt: 3_000,
    expectsCompletionMessage: false,
    outcome: { status: "ok" },
    childSessionIdentity: identity,
  });
  vi.mocked(deliveryRuntime.loadSessionEntryByKey).mockResolvedValue({
    sessionId: "current-conversation",
    lifecycleRevision: "original",
    updatedAt: 1,
  });
  const gateway = recordGatewayCalls();
  let completed = false;
  const controller = createLifecycleControllerFixture(
    {
      entry,
      beforeWrite: ({ postimages }) => {
        if (postimages.get(entry.runId)?.cleanupCompletedAt !== undefined) {
          completed = true;
        }
      },
    },
    {
      callGateway: gateway.callGateway,
      cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
      ownersByEntry: new Map(),
    },
  );
  expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
  await vi.waitFor(() => expect(completed).toBe(true));
  expect(gateway.calls).toHaveBeenCalledTimes(deletions);
  if (deletions) {
    expect(gateway.calls).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        params: expect.objectContaining({
          expectedSessionId: "current-conversation",
          expectedLifecycleRevision: "original",
        }),
      }),
    );
  }
});

it.each(["missing", "replaced", "unchanged"] as const)(
  "checks original custody against a %s current session",
  async (state) => {
    const entry = createRunEntry({
      childSessionIdentity: { sessionId: "original-session", lifecycleRevision: "original" },
    });
    vi.mocked(deliveryRuntime.loadSessionEntryByKey).mockResolvedValue(
      state === "missing"
        ? undefined
        : {
            sessionId: state === "replaced" ? "different-session" : "original-session",
            lifecycleRevision: "original",
            updatedAt: 1,
          },
    );
    const controller = createLifecycleControllerFixture(
      { entry },
      {
        callGateway: recordGatewayCalls().callGateway,
        cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
        ownersByEntry: new Map(),
      },
    );
    expect(await controller.shouldSuppressSessionEffects(entry)).toBe(state !== "unchanged");
  },
);
