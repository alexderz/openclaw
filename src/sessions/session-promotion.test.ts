import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as accessor from "../config/sessions/session-accessor.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { SessionPromotionConflictError } from "./session-promotion-state.js";
import { requestSessionPromotion } from "./session-promotion.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
});
const requester = {
  version: 1 as const,
  actor: { kind: "operator" as const, profileId: "human" },
  scopes: ["operator.sessions.write"],
  grant: null,
};
async function fixture() {
  const scope = {
    cfg: {},
    agentId: "main",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-promotion-")),
    },
    sessionKey: "agent:main:dashboard:visible",
  };
  await upsertSessionEntryCore(scope, {
    sessionId: "session",
    updatedAt: 1,
    lifecycleRevision: "before",
    spawnDepth: 1,
    spawnedBy: "agent:main:dashboard:parent",
    label: "Keep me",
  });
  return scope;
}
describe("promotion native lifecycle transaction", () => {
  it("maps a replaced captured generation to a promotion conflict, not a denial", async () => {
    const scope = await fixture();
    const update = vi
      .spyOn(accessor, "updateResolvedSessionEntry")
      .mockRejectedValueOnce(new Error("Captured session generation changed before update"));
    try {
      await expect(
        requestSessionPromotion({
          scope,
          expectedSessionId: "session",
          expectedLifecycleRevision: "before",
          requester,
          requestId: "request",
          assertCurrent: vi.fn(),
          now: 2,
        }),
      ).rejects.toBeInstanceOf(SessionPromotionConflictError);
    } finally {
      update.mockRestore();
    }
  });
  it("commits an idempotent pending intent without changing target incarnation", async () => {
    const scope = await fixture();
    const params = {
      scope,
      expectedSessionId: "session",
      expectedLifecycleRevision: "before",
      requester,
      requestId: "request",
      assertCurrent: vi.fn(),
      now: 2,
    };
    const result = await requestSessionPromotion(params);
    expect(result).toMatchObject({ state: "pending", requestId: "request" });
    const row = loadSessionEntry(scope);
    expect(row).toMatchObject({
      sessionId: "session",
      lifecycleRevision: "before",
      label: "Keep me",
      spawnDepth: 1,
      sessionPromotion: { state: "pending" },
    });
    expect(await requestSessionPromotion({ ...params, now: 3 })).toEqual(result);
    expect(loadSessionEntry(scope)).toEqual(row);
  });
  it("retains accepted intent after request close and never reactivates a cancelled id", async () => {
    const scope = await fixture();
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("closed");
      }
    };
    const params = {
      scope,
      expectedSessionId: "session",
      expectedLifecycleRevision: "before",
      requester,
      requestId: "request",
      assertCurrent,
      now: 2,
    };
    await requestSessionPromotion(params);
    current = false;
    expect(loadSessionEntry(scope)?.sessionPromotion?.state).toBe("pending");
    await expect(requestSessionPromotion({ ...params, action: "cancel" })).rejects.toThrow(
      "closed",
    );
    current = true;
    const cancelled = await requestSessionPromotion({ ...params, action: "cancel", now: 3 });
    expect(cancelled.state).toBe("cancelled");
    expect((await requestSessionPromotion({ ...params, now: 4 })).state).toBe("cancelled");
    expect(loadSessionEntry(scope)?.lifecycleRevision).toBe("before");
  });
  it("serializes competing request ids without replacing the accepted original", async () => {
    const scope = await fixture();
    const params = {
      scope,
      expectedSessionId: "session",
      expectedLifecycleRevision: "before",
      requester,
      assertCurrent: vi.fn(),
      now: 2,
    };
    const results = await Promise.allSettled([
      requestSessionPromotion({ ...params, requestId: "first" }),
      requestSessionPromotion({ ...params, requestId: "second" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(loadSessionEntry(scope)?.sessionPromotion?.requestId).toBe("first");
  });
  it("revalidates invocation custody at the actual store commit", async () => {
    const scope = await fixture();
    let calls = 0;
    let revoked = false;
    const assertCurrent = () => {
      if (revoked) {
        throw new Error("request closed before commit");
      }
      if (++calls === 4) {
        queueMicrotask(() => {
          revoked = true;
        });
      }
    };
    await expect(
      requestSessionPromotion({
        scope,
        expectedSessionId: "session",
        expectedLifecycleRevision: "before",
        requester,
        requestId: "request",
        assertCurrent,
        now: 2,
      }),
    ).rejects.toThrow("request closed before commit");
    expect(loadSessionEntry(scope)?.sessionPromotion).toBeUndefined();
  });
  it("denies stale requests under the writer without persisting intent", async () => {
    const scope = await fixture();
    await expect(
      requestSessionPromotion({
        scope,
        expectedSessionId: "old",
        expectedLifecycleRevision: "before",
        requester,
        requestId: "request",
        assertCurrent: vi.fn(),
        now: 2,
      }),
    ).rejects.toThrow();
    expect(loadSessionEntry(scope)?.sessionPromotion).toBeUndefined();
  });
});
