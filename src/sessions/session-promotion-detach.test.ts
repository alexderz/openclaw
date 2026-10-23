import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isSubagentSessionFromEntry } from "../agents/subagents/spawn/subagent-depth-policy.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import {
  canDetachPromotedSessionKey,
  detachPromotedSessionEntry,
  hasDelegationLineage,
  isDetachedPromotedSession,
} from "./session-promotion-detach.js";
import { captureSessionEffectiveAdmission } from "./session-promotion-state.js";
import {
  activatePendingSessionPromotion,
  detachActivatedSessionPromotion,
  requestSessionPromotion,
} from "./session-promotion.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
});

const delegatedRow = {
  sessionId: "session",
  updatedAt: 1,
  lifecycleRevision: "before",
  label: "Keep me",
  spawnDepth: 1,
  spawnedBy: "agent:main:dashboard:parent",
  spawnedBySessionId: "parent-session",
  spawnedBySenderIsOwner: true,
  parentSessionKey: "agent:main:dashboard:parent",
  parentSessionId: "parent-session",
  parentSessionLifecycleRevision: "parent-revision",
  completionOwnerSessionKey: "agent:main:dashboard:parent",
  inheritedToolPolicyVersion: 1 as const,
  inheritedToolAllow: ["read"],
  inheritedToolDeny: ["exec"],
  subagentRole: "leaf" as const,
  subagentControlScope: "none" as const,
  sandbox: "required" as const,
  createdVia: "spawn" as const,
  createdActor: { type: "agent" as const, id: "main" },
};

function scopeFor(sessionKey: string, cfg: Record<string, unknown> = {}) {
  return {
    cfg: cfg as never,
    agentId: "main",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: fs.realpathSync(dirs.make("promotion-detach-")),
    },
    sessionKey,
  };
}

async function pendingFixture(
  sessionKey = "agent:main:dashboard:visible",
  cfg: Record<string, unknown> = {},
  profileId = "human",
) {
  const scope = scopeFor(sessionKey, cfg);
  await upsertSessionEntryCore(scope, { ...delegatedRow });
  await requestSessionPromotion({
    scope,
    expectedSessionId: "session",
    expectedLifecycleRevision: "before",
    requester: {
      version: 1,
      actor: { kind: "operator", profileId },
      scopes:
        profileId === GATEWAY_OWNER_PROFILE_ID ? ["operator.admin"] : ["operator.sessions.write"],
      grant: null,
    },
    requestId: "request",
    assertCurrent: () => {},
    now: 2,
  });
  return {
    scope,
    expectedSessionId: "session",
    expectedLifecycleRevision: "before",
    requestId: "request",
    assertCurrent: vi.fn(),
    now: 3,
  };
}

describe("promotion detach", () => {
  it("rewrites a delegated row into the shape of a dashboard root", () => {
    const entry: Record<string, unknown> = {
      ...delegatedRow,
      spawnedWorkspaceDir: "/work/inherited",
    };
    expect(
      detachPromotedSessionEntry({
        entry,
        key: "agent:main:dashboard:visible",
        promotion: { requestId: "request", profileId: "human", activatedAt: 5 },
        rootParentSessionKey: "agent:main:main",
      }),
    ).toBe(true);
    expect(entry).toMatchObject({
      label: "Keep me",
      spawnDepth: 0,
      parentSessionKey: "agent:main:main",
      // The workspace later turns re-enter is unchanged.
      spawnedCwd: "/work/inherited",
      // Restrictions and provenance a dashboard root may also carry are not widened.
      sandbox: "required",
      createdVia: "spawn",
      promotedFrom: {
        version: 1,
        requestId: "request",
        profileId: "human",
        at: 5,
        parentSessionKey: "agent:main:dashboard:parent",
        parentSessionId: "parent-session",
        spawnDepth: 1,
      },
    });
    for (const field of [
      "spawnedBy",
      "spawnedBySessionId",
      "spawnedBySenderIsOwner",
      "parentSessionId",
      "parentSessionLifecycleRevision",
      "completionOwnerSessionKey",
      "inheritedToolPolicyVersion",
      "inheritedToolAllow",
      "inheritedToolDeny",
      "subagentRole",
      "subagentControlScope",
    ]) {
      expect(entry).not.toHaveProperty(field);
    }
    expect(hasDelegationLineage(entry)).toBe(false);
    expect(isDetachedPromotedSession(entry)).toBe(true);
    // Idempotent: a second pass changes nothing.
    const snapshot = structuredClone(entry);
    expect(
      detachPromotedSessionEntry({
        entry,
        key: "agent:main:dashboard:visible",
        promotion: { requestId: "other", profileId: "other", activatedAt: 9 },
        rootParentSessionKey: "agent:main:main",
      }),
    ).toBe(false);
    expect(entry).toEqual(snapshot);
  });

  it("classifies a detached row exactly like a never-delegated dashboard root", () => {
    const key = "agent:main:dashboard:visible";
    const entry: Record<string, unknown> = { ...delegatedRow };
    detachPromotedSessionEntry({
      entry,
      key,
      promotion: { requestId: "request", profileId: "human", activatedAt: 5 },
      rootParentSessionKey: "agent:main:main",
    });
    const native = {
      sessionId: "native",
      updatedAt: 1,
      spawnDepth: 0,
      parentSessionKey: "agent:main:main",
    };
    expect(isSubagentSessionFromEntry(key, entry as never)).toBe(false);
    expect(isSubagentSessionFromEntry(key, native as never)).toBe(false);
    expect(isPinnableSessionEntry(key, entry as never)).toBe(true);
    // Every turn kind: a turn with no human and no ceiling is ordinary, and no handle is minted.
    expect(
      captureSessionEffectiveAdmission({ entry: entry as never, sessionKey: key }).effectiveClass,
    ).toBe("ordinary");
  });

  it("leaves no parent link when the session scope has no per-agent main root", () => {
    const entry: Record<string, unknown> = { ...delegatedRow };
    detachPromotedSessionEntry({
      entry,
      key: "agent:main:dashboard:visible",
      promotion: { requestId: "request", profileId: "human", activatedAt: 5 },
    });
    expect(entry.parentSessionKey).toBeUndefined();
    expect(entry.spawnDepth).toBe(0);
  });

  it("keeps a parent link that is not the spawner when there is no dashboard root", () => {
    const entry: Record<string, unknown> = {
      ...delegatedRow,
      parentSessionKey: "agent:main:telegram:group:1",
    };
    detachPromotedSessionEntry({
      entry,
      key: "agent:main:telegram:group:1:thread:2",
      promotion: { requestId: "request", profileId: "human", activatedAt: 5 },
    });
    expect(entry.parentSessionKey).toBe("agent:main:telegram:group:1");
    expect(entry.spawnedBy).toBeUndefined();
    expect(entry.promotedFrom).toMatchObject({ parentSessionKey: "agent:main:dashboard:parent" });
  });

  it("never detaches a key that is delegated by its shape", () => {
    expect(canDetachPromotedSessionKey("agent:main:dashboard:visible")).toBe(true);
    expect(canDetachPromotedSessionKey("agent:main:cron:job:run:1")).toBe(true);
    expect(canDetachPromotedSessionKey("agent:main:subagent:task")).toBe(false);
    expect(canDetachPromotedSessionKey("agent:main:dashboard:x:subagent:task")).toBe(false);
    expect(canDetachPromotedSessionKey("agent:main:acp:session")).toBe(false);
    const entry: Record<string, unknown> = { ...delegatedRow };
    expect(
      detachPromotedSessionEntry({
        entry,
        key: "agent:main:subagent:task",
        promotion: { requestId: "request", profileId: "human", activatedAt: 5 },
      }),
    ).toBe(false);
    expect(entry.spawnedBy).toBe("agent:main:dashboard:parent");
  });

  it("declines the detach together with the activation when the commit recheck finds work", async () => {
    const p = await pendingFixture();
    let calls = 0;
    const result = await activatePendingSessionPromotion({
      ...p,
      probeBlockers: () => [],
      // The first read is in the store callback; the second, right before the write, sees work.
      recheckBlockers: () => (++calls > 1 ? ["late-admission"] : []),
    });
    expect(result).toMatchObject({ activated: false, detached: false });
    expect(loadSessionEntry(p.scope)).toMatchObject({
      lifecycleRevision: "before",
      spawnedBy: "agent:main:dashboard:parent",
      spawnDepth: 1,
      sessionPromotion: { state: "pending" },
    });
    expect(loadSessionEntry(p.scope)?.promotedFrom).toBeUndefined();
  });

  it("keeps the lineage of an admin-promoted sub-agent key, which stays delegated by key shape", async () => {
    const p = await pendingFixture("agent:main:subagent:task", {}, GATEWAY_OWNER_PROFILE_ID);
    const result = await activatePendingSessionPromotion({ ...p, probeBlockers: () => [] });
    expect(result).toMatchObject({ activated: true, detached: false });
    expect(loadSessionEntry(p.scope)).toMatchObject({
      spawnedBy: "agent:main:dashboard:parent",
      spawnDepth: 1,
      sessionPromotion: { state: "activated" },
    });
    expect(loadSessionEntry(p.scope)?.promotedFrom).toBeUndefined();
  });

  it("completes an activation committed by an earlier build, only when quiet, once", async () => {
    const scope = scopeFor("agent:main:dashboard:visible");
    await upsertSessionEntryCore(scope, {
      ...delegatedRow,
      lifecycleRevision: "after",
      // What an earlier build left: an activated receipt and the full spawn lineage.
      sessionPromotion: {
        version: 1,
        requestId: "request",
        acceptedAt: 2,
        target: {
          agentId: "main",
          key: "agent:main:dashboard:visible",
          sessionId: "session",
          fromLifecycleRevision: "before",
        },
        boundary: "settlement-or-fresh-human-input",
        profileId: "human",
        state: "activated",
        toLifecycleRevision: "after",
        activatedAt: 3,
      },
    });
    const params = {
      scope,
      expectedSessionId: "session",
      expectedLifecycleRevision: "after",
      assertCurrent: () => {},
    };
    expect(
      await detachActivatedSessionPromotion({ ...params, probeBlockers: () => ["run"] }),
    ).toMatchObject({ detached: false, blockers: ["run"] });
    expect(loadSessionEntry(scope)?.spawnedBy).toBe("agent:main:dashboard:parent");
    expect(
      await detachActivatedSessionPromotion({ ...params, probeBlockers: () => [] }),
    ).toMatchObject({ detached: true, blockers: [] });
    const entry = loadSessionEntry(scope)!;
    expect(entry).toMatchObject({
      lifecycleRevision: "after",
      spawnDepth: 0,
      parentSessionKey: "agent:main:main",
      sessionPromotion: { state: "activated", toLifecycleRevision: "after" },
      promotedFrom: { requestId: "request", profileId: "human", at: 3 },
    });
    expect(entry.spawnedBy).toBeUndefined();
    expect(entry.inheritedToolAllow).toBeUndefined();
    expect(
      await detachActivatedSessionPromotion({ ...params, probeBlockers: () => [] }),
    ).toMatchObject({ detached: false });
    // A pending or replaced row is never touched by this path.
    await expect(
      detachActivatedSessionPromotion({
        ...params,
        expectedLifecycleRevision: "before",
        probeBlockers: () => [],
      }),
    ).rejects.toThrow();
  });

  it("keeps the provenance across a reset while the row stays a root", async () => {
    const { preserveSessionLineage } = await import("../config/sessions/session-entry-lineage.js");
    const entry: Record<string, unknown> = { ...delegatedRow };
    detachPromotedSessionEntry({
      entry,
      key: "agent:main:dashboard:visible",
      promotion: { requestId: "request", profileId: "human", activatedAt: 5 },
      rootParentSessionKey: "agent:main:main",
    });
    const kept = preserveSessionLineage(entry as never);
    expect(kept).toMatchObject({
      spawnDepth: 0,
      parentSessionKey: "agent:main:main",
      promotedFrom: { requestId: "request" },
    });
    expect(kept.spawnedBy).toBeUndefined();
    expect(kept.inheritedToolAllow).toBeUndefined();
  });
});
