import { describe, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  promotionAdminBasisAllowed,
  resolveSessionPromotionOwnership,
} from "./session-promotion-ownership.js";

const cfg = { agents: { list: [{ id: "main" }] } } as OpenClawConfig;
const parentKey = "agent:main:dashboard:root";
const childKey = "agent:main:subagent:child";
const me = "alice";

// The root is an operator-created dashboard session that Alice owns.
const root = {
  sessionId: "root-session",
  createdActor: { type: "profile", id: me },
} as never;

function ownership(child: Record<string, unknown>, parent: Record<string, unknown> = root) {
  return resolveSessionPromotionOwnership({
    admin: false,
    cfg,
    profileId: me,
    scopes: ["operator.sessions.write"],
    isCreator: (actor) => actor?.type === "profile" && actor.id === me,
    target: {
      canonicalKey: childKey,
      entry: {
        createdActor: { type: "agent", id: "main" },
        parentSessionKey: parentKey,
        ...child,
      } as never,
    },
    readEntry: ({ key }) => (key === parentKey ? (parent as never) : undefined),
  });
}

describe("session promotion lineage", () => {
  it("owns an agent-created child whose spawnedBy and parentSessionId name its exact parent", () => {
    expect(
      ownership({ spawnedBy: parentKey, parentSessionId: "root-session", sessionId: "c" }),
    ).toEqual({ ok: true, basis: "lineage-own-root" });
  });

  it("denies an agent-created child whose spawnedBy names another session", () => {
    expect(
      ownership({
        spawnedBy: "agent:main:dashboard:other",
        parentSessionId: "root-session",
        sessionId: "c",
      }),
    ).toEqual({ ok: false, reason: "lineage-denied" });
  });

  it("denies an agent-created child whose parentSessionId is a previous incarnation of the parent", () => {
    expect(
      ownership({ spawnedBy: parentKey, parentSessionId: "old-session", sessionId: "c" }),
    ).toEqual({ ok: false, reason: "lineage-denied" });
  });

  it("denies an agent-created child that records no spawner", () => {
    expect(ownership({ parentSessionId: "root-session", sessionId: "c" })).toEqual({
      ok: false,
      reason: "lineage-denied",
    });
  });
});

describe("session promotion restore admin basis", () => {
  it("counts admin only for the gateway owner or when operator roles are configured", () => {
    expect(promotionAdminBasisAllowed({ profileId: GATEWAY_OWNER_PROFILE_ID, cfg })).toBe(true);
    expect(promotionAdminBasisAllowed({ profileId: me, cfg })).toBe(false);
    expect(
      promotionAdminBasisAllowed({ profileId: me, cfg: { gateway: { roles: {} } } as never }),
    ).toBe(true);
    expect(promotionAdminBasisAllowed({ profileId: undefined, cfg })).toBe(false);
  });
});
