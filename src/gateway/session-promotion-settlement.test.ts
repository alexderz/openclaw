import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ activate: vi.fn(), entries: vi.fn() }));
vi.mock("./server-methods/sessions-promotion-activation.js", () => ({
  activateSessionPromotionAfterSettlement: mocks.activate,
}));
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntrySummariesInWorker: mocks.entries,
}));

import { notifySessionWorkSettled } from "../sessions/session-work-settlement.js";
import {
  clearSessionPromotionPending,
  markSessionPromotionPending,
} from "./session-promotion-pending-keys.js";
import { startSessionPromotionSettlement } from "./session-promotion-settlement.js";

const key = "agent:main:dashboard:target";
const subagentKey = "agent:main:subagent:task";
const mainKey = "agent:main:main";
const idleKey = "agent:main:dashboard:idle";
const context = { getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }] } }) } as never;
let stop: (() => void) | undefined;
const flush = async (ms = 300) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.activate.mockResolvedValue("unchanged");
  mocks.entries.mockResolvedValue([]);
});
afterEach(() => {
  stop?.();
  for (const sessionKey of [key, subagentKey, mainKey, idleKey, "agent:main:dashboard:done"]) {
    clearSessionPromotionPending(sessionKey);
  }
  vi.useRealTimers();
});

describe("owner-scheduled promotion settlement", () => {
  it("coalesces repeated owner releases for one dashboard key into one attempt", async () => {
    markSessionPromotionPending(key);
    ({ stop } = startSessionPromotionSettlement(context, { warn: vi.fn() }));
    notifySessionWorkSettled([key, "session-id"]);
    notifySessionWorkSettled([key]);
    notifySessionWorkSettled([key]);
    await flush();
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.activate).toHaveBeenCalledWith({ context, sessionKey: key });
  });
  it("attempts only the agent-scoped keys with a pending intent, and ignores the rest", async () => {
    markSessionPromotionPending(subagentKey);
    markSessionPromotionPending(mainKey);
    ({ stop } = startSessionPromotionSettlement(context, { warn: vi.fn() }));
    notifySessionWorkSettled([subagentKey, mainKey, idleKey, "session-id", undefined]);
    await flush();
    expect(mocks.activate.mock.calls.map(([call]) => call.sessionKey)).toEqual([
      subagentKey,
      mainKey,
    ]);
  });
  it("does not attempt a key whose intent was settled and cleared", async () => {
    markSessionPromotionPending(key);
    clearSessionPromotionPending(key);
    ({ stop } = startSessionPromotionSettlement(context, { warn: vi.fn() }));
    notifySessionWorkSettled([key]);
    await flush();
    expect(mocks.activate).not.toHaveBeenCalled();
  });
  it("never schedules an incognito dashboard key, in any letter case", async () => {
    markSessionPromotionPending("agent:main:dashboard:incognito-abc");
    markSessionPromotionPending("agent:main:dashboard:Incognito-ABC");
    ({ stop } = startSessionPromotionSettlement(context, { warn: vi.fn() }));
    notifySessionWorkSettled([
      "agent:main:dashboard:incognito-abc",
      "agent:main:dashboard:Incognito-ABC",
    ]);
    await flush();
    expect(mocks.activate).not.toHaveBeenCalled();
  });
  it("re-runs once when another owner releases while an attempt is in flight, and survives failures", async () => {
    markSessionPromotionPending(key);
    const warn = vi.fn();
    ({ stop } = startSessionPromotionSettlement(context, { warn }));
    let release!: () => void;
    mocks.activate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve("unchanged");
        }),
    );
    notifySessionWorkSettled([key]);
    await flush();
    notifySessionWorkSettled([key]);
    await flush();
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    mocks.activate.mockRejectedValueOnce(new Error("conflict"));
    release();
    await flush(600);
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deferred"));
  });
  it("stops cleanly: no attempt after stop and no stray timers", async () => {
    markSessionPromotionPending(key);
    ({ stop } = startSessionPromotionSettlement(context, { warn: vi.fn() }));
    notifySessionWorkSettled([key]);
    stop();
    await flush();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("gives each persisted pending intent one attempt at startup, without waiting for a release", async () => {
    const promotion = (state: string) => ({
      version: 1,
      state,
      requestId: "request",
      acceptedAt: 1,
      boundary: "settlement-or-fresh-human-input",
      target: { agentId: "main", key, sessionId: "session", fromLifecycleRevision: "before" },
      requester: {
        version: 1,
        actor: { kind: "operator", profileId: "alice" },
        scopes: ["operator.sessions.write"],
        grant: null,
      },
    });
    const incognito = "agent:main:dashboard:incognito-a";
    mocks.entries.mockResolvedValue([
      { sessionKey: key, entry: { sessionId: "session", sessionPromotion: promotion("pending") } },
      {
        sessionKey: "agent:main:dashboard:done",
        entry: { sessionId: "done", sessionPromotion: { ...promotion("pending"), state: "x" } },
      },
      { sessionKey: "agent:main:dashboard:none", entry: { sessionId: "none" } },
      {
        sessionKey: incognito,
        entry: {
          sessionId: "incognito",
          sessionPromotion: {
            ...promotion("pending"),
            target: { ...promotion("pending").target, key: incognito },
          },
        },
      },
    ]);
    ({ stop } = startSessionPromotionSettlement(context, { warn: vi.fn() }));
    await flush();
    expect(mocks.entries).toHaveBeenCalledWith(expect.objectContaining({ agentId: "main" }));
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.activate).toHaveBeenCalledWith({ context, sessionKey: key });
    await flush(1_000);
    expect(mocks.activate).toHaveBeenCalledTimes(1);
  });
  it("an unreadable agent store at startup is logged and waits for the next release", async () => {
    const warn = vi.fn();
    mocks.entries.mockRejectedValue(new Error("store unavailable"));
    markSessionPromotionPending(key);
    ({ stop } = startSessionPromotionSettlement(context, { warn }));
    await flush();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("startup"));
    notifySessionWorkSettled([key]);
    await flush();
    expect(mocks.activate).toHaveBeenCalledTimes(1);
  });
});
