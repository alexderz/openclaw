import { describe, expect, it, vi } from "vitest";
import * as state from "./session-promotion-state.js";

const target = {
  agentId: "main",
  key: "agent:main:dashboard:visible",
  sessionId: "session",
  fromLifecycleRevision: "before",
};
const requester = {
  version: 1,
  actor: { kind: "operator", profileId: "human" },
  scopes: ["operator.sessions.write"],
  grant: null,
};
const pending = {
  version: 1,
  state: "pending",
  requestId: "request",
  acceptedAt: 1,
  target,
  requester,
  boundary: "settlement-or-fresh-human-input",
};
const entry = () => ({
  sessionId: "session",
  lifecycleRevision: "before",
  updatedAt: 0,
  spawnedBy: "agent:main:dashboard:parent",
  spawnDepth: 1,
  createdActor: { type: "profile", id: "human" },
  sessionPromotion: undefined as unknown,
});
function implementation(name: string) {
  const fn = Reflect.get(state, name);
  expect(fn, name + " owner must exist").toBeTypeOf("function");
  return fn;
}
describe("original device incarnation", () => {
  it("records the observed-paired device and its pairing incarnation on the pending intent only", () => {
    const apply = implementation("applySessionPromotionRequest");
    const row = entry();
    apply({
      entry: row,
      target,
      requester,
      requestId: "request",
      device: { id: "device-one", generation: "5:incarnation" },
      now: 1,
      assertCurrent: vi.fn(),
    });
    expect(row.sessionPromotion).toEqual({
      ...pending,
      deviceId: "device-one",
      deviceGeneration: "5:incarnation",
    });
    // A device without its incarnation (or the reverse) cannot prove a later ending.
    expect(state.decodeSessionPromotion({ ...pending, deviceId: "device-one" })).toBeUndefined();
    expect(
      state.decodeSessionPromotion({ ...pending, deviceGeneration: "5:incarnation" }),
    ).toBeUndefined();
    const cancelled = apply({
      entry: row,
      target,
      requester,
      requestId: "request",
      action: "cancel",
      now: 2,
      assertCurrent: vi.fn(),
    });
    expect(cancelled).not.toHaveProperty("deviceId");
    expect(state.decodeSessionPromotion({ ...pending, deviceId: "" })).toBeUndefined();
  });
});

describe("session promotion target eligibility", () => {
  const delegated = { spawnedBy: "agent:main:main", spawnDepth: 1 } as Record<
    string,
    unknown
  > as Parameters<typeof state.isDurableDashboardPromotionTarget>[1];
  it("accepts a durable visible dashboard conversation", () => {
    expect(state.isDurableDashboardPromotionTarget("agent:main:dashboard:visible", delegated)).toBe(
      true,
    );
  });
  it.each([
    ["an incognito dashboard key", "agent:main:dashboard:incognito-abc"],
    ["an upper-case incognito key", "agent:main:dashboard:INCOGNITO-abc"],
    ["a subagent key", "agent:main:subagent:task"],
    ["a nested key", "agent:main:dashboard:a:b"],
  ])("rejects %s in the check and in a persisted receipt", (_name, key) => {
    expect(state.isDurableDashboardPromotionTarget(key, delegated)).toBe(false);
    expect(
      state.decodeSessionPromotion({ ...pending, target: { ...target, key } }),
    ).toBeUndefined();
  });
  it("rejects an incognito row even under an ordinary-looking key", () => {
    expect(
      state.isDurableDashboardPromotionTarget("agent:main:dashboard:visible", {
        ...delegated,
        incognito: true,
      }),
    ).toBe(false);
  });
});

describe("session promotion transition owner", () => {
  it("persists only a current authorized intent, preserving revision and lineage", () => {
    const apply = implementation("applySessionPromotionRequest");
    const row = entry();
    const assertCurrent = vi.fn();
    apply({ entry: row, target, requester, requestId: "request", now: 1, assertCurrent });
    expect(assertCurrent).toHaveBeenCalled();
    expect(row).toEqual({ ...entry(), sessionPromotion: pending });
    apply({ entry: row, target, requester, requestId: "request", now: 9, assertCurrent });
    expect(row.sessionPromotion).toEqual(pending);
    expect(() =>
      apply({ entry: row, target, requester, requestId: "replace", now: 9, assertCurrent }),
    ).toThrow();
  });
  it("checks current authorization even on duplicate and cancellation", () => {
    const apply = implementation("applySessionPromotionRequest");
    const row = { ...entry(), sessionPromotion: pending };
    for (const action of ["request", "cancel"]) {
      expect(() =>
        apply({
          entry: row,
          target,
          requester,
          requestId: "request",
          action,
          now: 2,
          assertCurrent: () => {
            throw new Error("revoked");
          },
        }),
      ).toThrow("revoked");
      expect(row.sessionPromotion).toEqual(pending);
    }
  });
  it("does not replay or cancel an intent belonging to a different target binding", () => {
    const apply = implementation("applySessionPromotionRequest");
    const row = {
      ...entry(),
      sessionPromotion: { ...pending, target: { ...target, sessionId: "previous-incarnation" } },
    };
    for (const action of ["request", "cancel"]) {
      expect(() =>
        apply({
          entry: row,
          target,
          requester,
          requestId: "request",
          action,
          now: 2,
          assertCurrent: vi.fn(),
        }),
      ).toThrow();
    }
  });
  it("waits without widening and switches revision only at verified settlement", () => {
    const activate = implementation("activatePendingSessionPromotion");
    const row = { ...entry(), sessionPromotion: pending };
    const input = { entry: row, target, now: 2, nextRevision: "after", assertCurrent: vi.fn() };
    expect(activate({ ...input, blockers: ["task"] })).toBe(false);
    expect(row.lifecycleRevision).toBe("before");
    expect(activate({ ...input, blockers: [] })).toBe(true);
    expect(row.lifecycleRevision).toBe("after");
    expect(row.sessionPromotion).toEqual({
      version: 1,
      state: "activated",
      requestId: "request",
      acceptedAt: 1,
      target,
      boundary: pending.boundary,
      profileId: "human",
      activatedAt: 2,
      toLifecycleRevision: "after",
    });
    expect(row.spawnDepth).toBe(1);
  });
  it("rejects stale incarnations and hidden ephemeral targets", () => {
    const apply = implementation("applySessionPromotionRequest");
    for (const patch of [{ sessionId: "different" }, { lifecycleRevision: "different" }]) {
      expect(() =>
        apply({
          entry: { ...entry(), ...patch },
          target,
          requester,
          requestId: "request",
          now: 1,
          assertCurrent: vi.fn(),
        }),
      ).toThrow();
    }
    expect(() =>
      apply({
        entry: entry(),
        target: { ...target, key: "agent:main:subagent:hidden" },
        requester,
        requestId: "request",
        now: 1,
        assertCurrent: vi.fn(),
      }),
    ).toThrow();
  });
  it("does not treat an activated metadata receipt as authority", () => {
    const capture = implementation("captureSessionEffectiveAdmission");
    const row = {
      ...entry(),
      lifecycleRevision: "after",
      sessionPromotion: {
        version: 1,
        state: "activated",
        requestId: "request",
        acceptedAt: 1,
        target,
        boundary: pending.boundary,
        profileId: "human",
        activatedAt: 2,
        toLifecycleRevision: "after",
      },
    };
    const ceiling = { allow: ["sessions_send"], deny: ["exec"] };
    const ordinary = capture({
      entry: row,
      sessionKey: target.key,
      humanProfileId: "human",
      policyCeiling: ceiling,
      admittedIdentity: { sessionId: "session", lifecycleRevision: "after" },
      assertCurrent: vi.fn(),
    });
    expect(
      capture({
        entry: row,
        sessionKey: target.key,
        humanProfileId: "human",
        policyCeiling: ceiling,
        admittedIdentity: { sessionId: "session", lifecycleRevision: "before" },
        assertCurrent: vi.fn(),
      }).effectiveClass,
    ).toBe("delegated");
    ceiling.allow.push("exec");
    expect(ordinary.policyCeiling).toEqual({ allow: ["sessions_send"], deny: ["exec"] });
    expect(Object.isFrozen(ordinary.policyCeiling.allow)).toBe(true);
    expect(
      capture({
        entry: row,
        sessionKey: target.key,
        humanProfileId: "human",
        assertCurrent: vi.fn(),
      }).effectiveClass,
    ).toBe("delegated");
    expect(ordinary.effectiveClass).toBe("ordinary");
    expect(Object.isFrozen(ordinary)).toBe(true);
    expect(capture({ entry: row, sessionKey: target.key }).effectiveClass).toBe("delegated");
    expect(
      capture({
        entry: row,
        sessionKey: target.key,
        humanProfileId: "other",
        assertCurrent: vi.fn(),
      }).effectiveClass,
    ).toBe("delegated");
    row.lifecycleRevision = "later";
    expect(ordinary.lifecycleRevision).toBe("after");
  });
  it("brands only the handle minted at a verified activation", () => {
    const capture = implementation("captureSessionEffectiveAdmission");
    const branded = implementation("isActivatedOrdinarySessionEffectiveAdmission");
    const activated = {
      ...entry(),
      lifecycleRevision: "after",
      sessionPromotion: {
        version: 1,
        state: "activated",
        requestId: "request",
        acceptedAt: 1,
        target,
        boundary: pending.boundary,
        profileId: "human",
        activatedAt: 2,
        toLifecycleRevision: "after",
      },
    };
    const fresh = { humanProfileId: "human", assertCurrent: vi.fn(), policyCeiling: {} };
    const ordinary = capture({ entry: activated, sessionKey: target.key, ...fresh });
    expect(ordinary.effectiveClass).toBe("ordinary");
    expect(branded(ordinary)).toBe(true);
    expect(branded({ ...ordinary })).toBe(false);
    expect(branded(structuredClone(ordinary))).toBe(false);
    const delegated = capture({
      entry: { ...activated, lifecycleRevision: "later" },
      sessionKey: target.key,
      ...fresh,
    });
    expect(delegated.effectiveClass).toBe("delegated");
    expect(branded(delegated)).toBe(false);
    // A never-delegated row is "ordinary" for display only and lifts nothing.
    const plain = capture({
      entry: { sessionId: "plain", lifecycleRevision: "r", updatedAt: 0 },
      sessionKey: "agent:main:subagent:legacy",
      ...fresh,
    });
    expect(plain.effectiveClass).toBe("ordinary");
    expect(branded(plain)).toBe(false);
    expect(branded(undefined)).toBe(false);
  });
});
