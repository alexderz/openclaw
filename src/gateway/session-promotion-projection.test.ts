import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { SessionPromotionProjectionSchema } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { projectSessionPromotion } from "./session-promotion-projection.js";
const key = "agent:main:dashboard:visible";
const entry = {
  sessionId: "session",
  lifecycleRevision: "before",
  updatedAt: 1,
  spawnedBy: "parent",
  spawnDepth: 1,
};
const pending = {
  version: 1,
  state: "pending",
  requestId: "request",
  acceptedAt: 1,
  boundary: "settlement-or-fresh-human-input",
  target: { agentId: "main", key, sessionId: "session", fromLifecycleRevision: "before" },
  requester: {
    version: 1,
    actor: { kind: "operator", profileId: "human" },
    scopes: ["operator.sessions.write"],
    grant: null,
  },
};
describe("per-viewer promotion projection", () => {
  it("intersects target eligibility with current viewer authorization, never publishes authority", () => {
    const authorize = vi.fn(() => true);
    const allowed = projectSessionPromotion({ key, entry, authorize, now: 3 });
    expect(allowed).toMatchObject({
      historicalOrigin: "delegated",
      effectiveClass: "delegated",
      canPromote: true,
      promotionState: "none",
      capabilities: { sessionsSend: "unknown" },
    });
    expect(authorize).toHaveBeenCalledOnce();
    const denied = projectSessionPromotion({ key, entry, authorize: () => false, now: 3 });
    expect(denied.canPromote).toBe(false);
    expect(denied.disabledReasons).toContain("current-human-authorization-required");
    const projection = projectSessionPromotion({
      key,
      entry: { ...entry, sessionPromotion: pending },
      authorize,
      now: 3,
    });
    expect(projection).toMatchObject({
      canPromote: false,
      promotionState: "pending",
      activationBoundary: "next-fresh-human-run-after-quiescence",
    });
    expect(JSON.stringify(projection)).not.toContain("requester");
    expect(JSON.stringify(projection)).not.toContain("profileId");
  });
  it("does not call stale receipts active or infer a messaging permission", () => {
    const receipt = {
      version: 1,
      state: "activated",
      requestId: "request",
      acceptedAt: 1,
      boundary: "settlement-or-fresh-human-input",
      activatedAt: 2,
      target: pending.target,
      profileId: "human",
      toLifecycleRevision: "after",
    };
    expect(
      projectSessionPromotion({
        key,
        entry: { ...entry, lifecycleRevision: "after", sessionPromotion: receipt },
        authorize: () => true,
        viewerProfileId: "human",
        now: 3,
      }),
    ).toMatchObject({ effectiveClass: "ordinary", promotionState: "activated" });
    expect(
      projectSessionPromotion({
        key,
        entry: { ...entry, lifecycleRevision: "later", sessionPromotion: receipt },
        authorize: () => true,
        now: 3,
      }),
    ).toMatchObject({ effectiveClass: "unknown", canPromote: false, promotionState: "blocked" });
    expect(
      projectSessionPromotion({
        key: "agent:main:subagent:legacy",
        entry,
        authorize: () => true,
        now: 3,
      }).canPromote,
    ).toBe(false);
  });
});
describe("pending cancellation contract (typed wire projection)", () => {
  const project = (extra: object, authorize = () => true) =>
    projectSessionPromotion({
      key,
      entry: { ...entry, sessionPromotion: pending, ...extra },
      authorize,
      now: 3,
    });
  it("exposes canCancel and the original intent id only to an authorized viewer, validated by the protocol schema", () => {
    const allowed = project({});
    expect(allowed).toMatchObject({
      canPromote: false,
      canCancel: true,
      pendingRequestId: "request",
      promotionState: "pending",
    });
    expect(Value.Check(SessionPromotionProjectionSchema, allowed)).toBe(true);
    const denied = project({}, () => false);
    expect(denied.canCancel).toBe(false);
    expect(denied).not.toHaveProperty("pendingRequestId");
    expect(Value.Check(SessionPromotionProjectionSchema, denied)).toBe(true);
    expect(JSON.stringify(allowed)).not.toContain("profileId");
    expect(JSON.stringify(allowed)).not.toContain("requester");
  });
  it("never invents cancellation from a pending label for stale, unsupported or settled states", () => {
    expect(project({ lifecycleRevision: "later" })).toMatchObject({ canCancel: false });
    expect(project({ lifecycleRevision: "later" })).not.toHaveProperty("pendingRequestId");
    expect(project({ sessionId: "replacement" }).canCancel).toBe(false);
    const ephemeral = projectSessionPromotion({
      key: "agent:main:subagent:task",
      entry: { ...entry, sessionPromotion: pending },
      authorize: () => true,
      now: 3,
    });
    expect(ephemeral.canCancel).toBe(false);
    for (const state of ["cancelled", "none"] as const) {
      const settled = projectSessionPromotion({
        key,
        entry:
          state === "none"
            ? entry
            : {
                ...entry,
                sessionPromotion: {
                  ...pending,
                  state: "cancelled",
                  profileId: "human",
                  settledAt: 2,
                  requester: undefined,
                },
              },
        authorize: () => true,
        now: 3,
      });
      expect(settled.canCancel).toBe(false);
      expect(settled).not.toHaveProperty("pendingRequestId");
    }
  });
});

describe("truthful ordinary scope after activation", () => {
  const receipt = {
    version: 1,
    state: "activated",
    requestId: "request",
    acceptedAt: 1,
    boundary: "settlement-or-fresh-human-input",
    activatedAt: 2,
    target: pending.target,
    profileId: "human",
    toLifecycleRevision: "after",
  };
  const activated = { ...entry, lifecycleRevision: "after", sessionPromotion: receipt };
  const project = (viewerProfileId?: string, e: object = activated) =>
    projectSessionPromotion({
      key,
      entry: e as never,
      authorize: () => true,
      viewerProfileId,
      now: 3,
    });
  it("calls the class ordinary only for the requesting human and scopes it to direct turns", () => {
    const requester = project("human");
    expect(requester).toMatchObject({
      effectiveClass: "ordinary",
      classScope: "requesting-human-direct-turns",
      promotionState: "activated",
    });
    expect(Value.Check(SessionPromotionProjectionSchema, requester)).toBe(true);
    for (const viewer of ["someone-else", undefined]) {
      const other = project(viewer);
      expect(other).toMatchObject({
        effectiveClass: "delegated",
        classScope: "requesting-human-direct-turns",
      });
      expect(Value.Check(SessionPromotionProjectionSchema, other)).toBe(true);
    }
    expect(JSON.stringify(requester)).not.toContain("profileId");
  });
  it("reports a natively ordinary session as ordinary for all turns and a delegated one as scope none", () => {
    expect(
      projectSessionPromotion({
        key,
        entry: { sessionId: "s", lifecycleRevision: "r", updatedAt: 1 },
        authorize: () => true,
        viewerProfileId: "human",
        now: 3,
      }),
    ).toMatchObject({ effectiveClass: "ordinary", classScope: "all-turns" });
    expect(project("human", entry)).toMatchObject({
      effectiveClass: "delegated",
      classScope: "none",
    });
  });
});
describe("terminal revoked intent contract", () => {
  const revoked = {
    version: 1,
    state: "revoked",
    requestId: "request",
    acceptedAt: 1,
    boundary: "settlement-or-fresh-human-input",
    profileId: "human",
    settledAt: 2,
    reason: "original-basis-ended",
    target: pending.target,
  };
  it("keeps the revoked state visible and allows a new request by an authorized viewer", () => {
    const authorized = projectSessionPromotion({
      key,
      entry: { ...entry, lifecycleRevision: "before", sessionPromotion: revoked },
      authorize: () => true,
      viewerProfileId: "human",
      now: 3,
    });
    expect(authorized).toMatchObject({ promotionState: "revoked", canPromote: true });
    expect(authorized.disabledReasons).toEqual([]);
    const unauthorized = projectSessionPromotion({
      key,
      entry: { ...entry, lifecycleRevision: "before", sessionPromotion: revoked },
      authorize: () => false,
      now: 3,
    });
    expect(unauthorized.canPromote).toBe(false);
    expect(unauthorized.disabledReasons).toContain("current-human-authorization-required");
  });
  it("never offers promotion for an incognito dashboard key", () => {
    const incognito = projectSessionPromotion({
      key: "agent:main:dashboard:incognito-abc",
      entry,
      authorize: () => true,
      viewerProfileId: "human",
      now: 3,
    });
    expect(incognito.canPromote).toBe(false);
    expect(incognito.disabledReasons).toContain("unsupported-target");
  });
});
