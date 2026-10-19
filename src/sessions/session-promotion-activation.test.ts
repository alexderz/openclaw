import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as accessor from "../config/sessions/session-accessor.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { prepareSessionDeliveryGeneration } from "../config/sessions/session-delivery-generation.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
} from "./session-lifecycle-admission.js";
import { SessionPromotionConflictError } from "./session-promotion-state.js";
import {
  activatePendingSessionPromotion,
  requestSessionPromotion,
  revokePendingSessionPromotion,
} from "./session-promotion.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
});
async function fixture() {
  const scope = {
    cfg: {},
    agentId: "main",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: fs.realpathSync(dirs.make("promotion-activation-")),
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
  await requestSessionPromotion({
    scope,
    expectedSessionId: "session",
    expectedLifecycleRevision: "before",
    requester: {
      version: 1,
      actor: { kind: "operator", profileId: "human" },
      scopes: ["operator.sessions.write"],
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
describe("pending promotion activation transaction", () => {
  it("maps a replaced captured generation to a promotion conflict for activation and revocation", async () => {
    const p = await fixture();
    const update = vi
      .spyOn(accessor, "updateResolvedSessionEntry")
      .mockRejectedValue(new Error("Captured session generation changed before update"));
    try {
      await expect(
        activatePendingSessionPromotion({ ...p, probeBlockers: () => [] }),
      ).rejects.toBeInstanceOf(SessionPromotionConflictError);
      await expect(revokePendingSessionPromotion({ ...p, reason: "ended" })).rejects.toBeInstanceOf(
        SessionPromotionConflictError,
      );
    } finally {
      update.mockRestore();
    }
  });
  it("keeps intent pending while owner-probed work remains; only a quiet boundary advances revision", async () => {
    const p = await fixture();
    const blocked = await activatePendingSessionPromotion({
      ...p,
      probeBlockers: () => ["admitted-input"],
    });
    expect(blocked).toMatchObject({
      activated: false,
      blockers: ["admitted-input"],
      promotion: { state: "pending" },
    });
    expect(loadSessionEntry(p.scope)?.lifecycleRevision).toBe("before");
    const result = await activatePendingSessionPromotion({ ...p, probeBlockers: () => [] });
    expect(result).toMatchObject({
      activated: true,
      blockers: [],
      promotion: { state: "activated" },
    });
    const entry = loadSessionEntry(p.scope)!;
    expect(entry.lifecycleRevision).not.toBe("before");
    expect(entry).toMatchObject({
      sessionId: "session",
      label: "Keep me",
      spawnDepth: 1,
      spawnedBy: "agent:main:dashboard:parent",
    });
    expect(entry.sessionPromotion).not.toHaveProperty("requester");
    await expect(
      activatePendingSessionPromotion({
        ...p,
        expectedLifecycleRevision: "unrelated",
        probeBlockers: () => [],
      }),
    ).rejects.toThrow();
  });
  it("revalidates current authority after probing and refuses stale incarnation", async () => {
    const p = await fixture();
    await expect(
      activatePendingSessionPromotion({
        ...p,
        probeBlockers: () => {
          p.assertCurrent.mockImplementation(() => {
            throw new Error("revoked");
          });
          return [];
        },
      }),
    ).rejects.toThrow("revoked");
    expect(loadSessionEntry(p.scope)?.lifecycleRevision).toBe("before");
    p.assertCurrent.mockImplementation(() => {});
    await expect(
      activatePendingSessionPromotion({
        ...p,
        expectedSessionId: "different",
        probeBlockers: () => [],
      }),
    ).rejects.toThrow();
    expect(loadSessionEntry(p.scope)?.sessionPromotion?.state).toBe("pending");
  });
  it("does not activate a cancellation or a different request", async () => {
    const p = await fixture();
    await expect(
      activatePendingSessionPromotion({ ...p, requestId: "different", probeBlockers: () => [] }),
    ).rejects.toThrow();
    await requestSessionPromotion({
      ...p,
      requester: {
        version: 1,
        actor: { kind: "operator", profileId: "human" },
        scopes: ["operator.sessions.write"],
        grant: null,
      },
      action: "cancel",
    });
    const result = await activatePendingSessionPromotion({ ...p, probeBlockers: () => [] });
    expect(result.activated).toBe(false);
    expect(loadSessionEntry(p.scope)?.lifecycleRevision).toBe("before");
  });
  it("records which basis activated: restored original or a same-human fresh rebinding", async () => {
    const p = await fixture();
    const result = await activatePendingSessionPromotion({
      ...p,
      basis: "fresh-human-rebound",
      probeBlockers: () => [],
    });
    expect(result.promotion).toMatchObject({ state: "activated", basis: "fresh-human-rebound" });
    expect(loadSessionEntry(p.scope)?.sessionPromotion).toMatchObject({
      basis: "fresh-human-rebound",
    });
  });
  it("revokes a pending intent terminally; it is never revived by a later activation or replay", async () => {
    const p = await fixture();
    const revoked = await revokePendingSessionPromotion({
      scope: p.scope,
      expectedSessionId: p.expectedSessionId,
      expectedLifecycleRevision: p.expectedLifecycleRevision,
      requestId: p.requestId,
      reason: "original-basis-ended",
      now: 4,
    });
    expect(revoked).toMatchObject({ state: "revoked", reason: "original-basis-ended" });
    expect(revoked).not.toHaveProperty("requester");
    const entry = loadSessionEntry(p.scope)!;
    expect(entry.lifecycleRevision).toBe("before");
    expect(entry.sessionId).toBe("session");
    const again = await activatePendingSessionPromotion({ ...p, probeBlockers: () => [] });
    expect(again.activated).toBe(false);
    expect(loadSessionEntry(p.scope)?.sessionPromotion?.state).toBe("revoked");
    // A deliberate new request id starts a new intent; the old id stays terminal.
    const next = await requestSessionPromotion({
      scope: p.scope,
      expectedSessionId: "session",
      expectedLifecycleRevision: "before",
      requester: {
        version: 1,
        actor: { kind: "operator", profileId: "human" },
        scopes: ["operator.sessions.write"],
        grant: null,
      },
      requestId: "second",
      assertCurrent: () => {},
      now: 5,
    });
    expect(next).toMatchObject({ state: "pending", requestId: "second" });
  });
  it("a slow owner probe holds neither the lifecycle fence nor the store writer, and ingress during it blocks the commit", async () => {
    const p = await fixture();
    const { storePath } = accessor.resolveSessionEntryAccessTarget(p.scope, {
      keyFormat: "agent-qualified",
    });
    const identities = [p.scope.sessionKey, p.expectedSessionId];
    const probing = createDeferredCore();
    const gate = createDeferredCore();
    const activation = activatePendingSessionPromotion({
      ...p,
      probeBlockers: async () => {
        probing.resolve();
        await gate.promise;
        return [];
      },
    });
    await probing.promise;
    try {
      // Exactly the check delivery generation makes before every delivery.
      expect(isSessionLifecycleMutationActive(storePath, identities)).toBe(false);
      const delivery = await prepareSessionDeliveryGeneration({
        agentId: "main",
        storePath,
        sessionKey: p.scope.sessionKey,
        sessionId: p.expectedSessionId,
        lifecycleRevision: "before",
      });
      expect(() => delivery.assertCurrent()).not.toThrow();
      delivery.release();
      // Other writers on the same agent store finish while the probe is still awaiting.
      await upsertSessionEntryCore(
        { ...p.scope, sessionKey: "agent:main:dashboard:other" },
        { sessionId: "other", updatedAt: 4 },
      );
      // A turn that is admitted and already finished during the probe still blocks this commit.
      const turn = await beginSessionWorkAdmission({
        scope: storePath,
        identities,
        assertAllowed: () => {},
      });
      turn.release();
    } finally {
      gate.resolve();
    }
    const result = await activation;
    expect(result).toMatchObject({ activated: false, promotion: { state: "pending" } });
    expect(result.blockers).toContain("admission-reserved-during-probe");
    expect(loadSessionEntry(p.scope)?.lifecycleRevision).toBe("before");
    // The next attempt after that turn ended is not blocked by it.
    await expect(
      activatePendingSessionPromotion({ ...p, probeBlockers: () => [] }),
    ).resolves.toMatchObject({ activated: true });
  });
  it("an admission reserved while the commit waits to write prevents the revision rotation", async () => {
    const p = await fixture();
    const { storePath } = accessor.resolveSessionEntryAccessTarget(p.scope, {
      keyFormat: "agent-qualified",
    });
    const original = accessor.updateResolvedSessionEntry;
    let turn: ReturnType<typeof beginSessionWorkAdmission> | undefined;
    const update = vi
      .spyOn(accessor, "updateResolvedSessionEntry")
      .mockImplementation((scope, updater, options) =>
        original(scope, updater, {
          ...options!,
          shouldCommit: () => {
            // A chat.send reserves pending synchronously, then waits on the fence.
            turn ??= beginSessionWorkAdmission({
              scope: storePath,
              identities: [p.scope.sessionKey],
              assertAllowed: () => {},
            });
            return options?.shouldCommit?.() ?? true;
          },
        }),
      );
    let result: Awaited<ReturnType<typeof activatePendingSessionPromotion>>;
    try {
      result = await activatePendingSessionPromotion({ ...p, probeBlockers: () => [] });
    } finally {
      update.mockRestore();
    }
    expect(turn).toBeDefined();
    (await turn!).release();
    expect(result).toMatchObject({ activated: false, promotion: { state: "pending" } });
    expect(loadSessionEntry(p.scope)).toMatchObject({
      lifecycleRevision: "before",
      sessionPromotion: { state: "pending" },
    });
  });
  it("refuses to revoke another request id or a replaced incarnation", async () => {
    const p = await fixture();
    for (const change of [{ requestId: "other" }, { expectedSessionId: "replacement" }]) {
      await expect(
        revokePendingSessionPromotion({
          scope: p.scope,
          expectedSessionId: p.expectedSessionId,
          expectedLifecycleRevision: p.expectedLifecycleRevision,
          requestId: p.requestId,
          reason: "x",
          ...change,
        }),
      ).rejects.toThrow();
    }
    expect(loadSessionEntry(p.scope)?.sessionPromotion?.state).toBe("pending");
  });
});
