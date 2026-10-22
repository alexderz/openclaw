import { describe, expect, it } from "vitest";
import { decodeSessionPromotion } from "../../sessions/session-promotion-state.js";
import { isPinnableSessionEntry } from "./session-pin-policy.js";

const DASHBOARD_KEY = "agent:main:dashboard:promoted";
const SUBAGENT_KEY = "agent:main:subagent:promoted";

const requester = {
  version: 1,
  actor: { kind: "operator", profileId: "human" },
  scopes: ["operator.sessions.write"],
  grant: null,
};

function promotion(key: string, state: "activated" | "pending" | "cancelled", toRevision = "r2") {
  const base = {
    version: 1,
    requestId: "request",
    acceptedAt: 1,
    target: { agentId: "main", key, sessionId: "sess", fromLifecycleRevision: "r1" },
    boundary: "settlement-or-fresh-human-input",
  };
  if (state === "pending") {
    return { ...base, state, requester };
  }
  if (state === "cancelled") {
    return { ...base, profileId: "human", state, settledAt: 2 };
  }
  return { ...base, profileId: "human", state, activatedAt: 2, toLifecycleRevision: toRevision };
}

describe("isPinnableSessionEntry", () => {
  it.each(["activated", "pending", "cancelled"] as const)(
    "uses a valid %s receipt fixture",
    (state) => {
      expect(decodeSessionPromotion(promotion(DASHBOARD_KEY, state))?.state).toBe(state);
    },
  );

  it.each([DASHBOARD_KEY, SUBAGENT_KEY])(
    "pins a delegated %s once its promotion is activated, keeping its lineage",
    (key) => {
      const entry = {
        sessionId: "sess",
        lifecycleRevision: "r2",
        spawnedBy: "agent:main:main",
        parentSessionKey: "agent:main:dashboard:parent",
        sessionPromotion: promotion(key, "activated"),
      };
      expect(isPinnableSessionEntry(key, entry)).toBe(true);
      expect(entry.spawnedBy).toBe("agent:main:main");
      expect(entry.parentSessionKey).toBe("agent:main:dashboard:parent");
    },
  );

  it("pins a parent-linked child once its promotion is activated", () => {
    expect(
      isPinnableSessionEntry(DASHBOARD_KEY, {
        sessionId: "sess",
        lifecycleRevision: "r2",
        parentSessionKey: "agent:main:dashboard:parent",
        sessionPromotion: promotion(DASHBOARD_KEY, "activated"),
      }),
    ).toBe(true);
  });

  it.each([
    ["no promotion", undefined],
    ["a pending promotion", promotion(DASHBOARD_KEY, "pending")],
    ["a cancelled promotion", promotion(DASHBOARD_KEY, "cancelled")],
    ["an activation for another key", promotion("agent:main:dashboard:other", "activated")],
    ["an activation of an older lifecycle revision", promotion(DASHBOARD_KEY, "activated", "r0")],
    ["a malformed receipt", { state: "activated" }],
  ])("keeps a delegated child unpinnable with %s", (_name, sessionPromotion) => {
    for (const lineage of [
      { spawnedBy: "agent:main:main" },
      { parentSessionKey: "agent:main:dashboard:parent" },
    ]) {
      expect(
        isPinnableSessionEntry(DASHBOARD_KEY, {
          sessionId: "sess",
          lifecycleRevision: "r2",
          ...lineage,
          sessionPromotion,
        }),
      ).toBe(false);
    }
  });

  it("keeps an activation for another session id unpinnable", () => {
    expect(
      isPinnableSessionEntry(DASHBOARD_KEY, {
        sessionId: "replacement",
        lifecycleRevision: "r2",
        spawnedBy: "agent:main:main",
        sessionPromotion: promotion(DASHBOARD_KEY, "activated"),
      }),
    ).toBe(false);
  });
});
