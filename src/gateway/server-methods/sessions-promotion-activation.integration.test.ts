import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  resolveSessionEntryAccessTarget,
  updateResolvedSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import * as lifecycle from "../../sessions/session-lifecycle-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { requestSessionPromotion } from "../../sessions/session-promotion.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { projectSessionPromotion } from "../session-promotion-projection.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  restore: vi.fn(),
  access: vi.fn(),
}));
vi.mock("../github-publication-requester.js", () => ({
  captureGitHubPublicationRequester: mocks.capture,
  restoreGitHubPublicationRequester: mocks.restore,
}));
vi.mock("../session-access-authority.js", () => ({
  prepareGatewaySessionAccessAuthority: mocks.access,
}));

import { activateSessionPromotionBeforeAdmission } from "./sessions-promotion-activation.js";
import { probeSessionPromotionQuiescence } from "./sessions-promotion-quiescence.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const key = "agent:main:dashboard:visible";
const requester = {
  version: 1 as const,
  actor: { kind: "operator" as const, profileId: "alice" },
  scopes: ["operator.sessions.write"],
  grant: null,
};
let stateDir: string;

beforeEach(() => {
  vi.resetAllMocks();
  stateDir = fs.realpathSync(dirs.make("promotion-boundary-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  mocks.access.mockResolvedValue({ assertCurrent: () => {}, release: () => {} });
  mocks.capture.mockResolvedValue({
    requester: { snapshot: requester, assertCurrent: () => {} },
    release: () => {},
  });
  mocks.restore.mockResolvedValue({
    snapshot: requester,
    assertCurrent: () => {},
    release: () => {},
  });
});
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function human(profileId = "alice") {
  const client = {
    connId: "human",
    authenticatedUserId: "user",
    authenticatedUserProfile: { profileId },
    connect: { role: "operator", scopes: ["operator.sessions.write"] },
    internal: {
      authenticatedOperator: true,
      authenticatedControlUi: true,
      operatorRoleActor: { kind: "operator", profileId },
    },
  };
  return {
    client,
    context: {
      chatAbortControllers: new Map(),
      dedupe: new Map(),
      chatQueuedTurns: new Map(),
      // The real (empty) placement owner: its absence is not quiescence.
      workerSessionPlacementService: createWorkerSessionPlacementStore(),
      getRuntimeConfig: () => ({}),
      getClientConnIds: (filter: (value: unknown) => boolean) =>
        new Set(filter(client) ? [client.connId] : []),
    },
  } as unknown as Parameters<typeof activateSessionPromotionBeforeAdmission>[0]["options"];
}
async function seed(extra: Partial<SessionEntry> = {}) {
  const scope = { cfg: {}, agentId: "main", env: process.env, sessionKey: key };
  await upsertSessionEntryCore(scope, {
    sessionId: "session",
    updatedAt: 1,
    lifecycleRevision: "before",
    spawnDepth: 1,
    spawnedBy: "agent:main:dashboard:parent",
    label: "Keep me",
    ...extra,
  });
  await requestSessionPromotion({
    scope,
    expectedSessionId: "session",
    expectedLifecycleRevision: "before",
    requester,
    requestId: "request",
    assertCurrent: () => {},
    now: 2,
  });
  return scope;
}

describe("fresh-human promotion boundary against the real store and real owner inventories", () => {
  it("activates in place when every owner is quiet: same key and session, new opaque revision", async () => {
    const scope = await seed();
    const outcome = await activateSessionPromotionBeforeAdmission({
      options: human(),
      sessionKey: key,
    });
    expect(outcome).toBe("activated");
    const entry = loadSessionEntry(scope)!;
    expect(entry.sessionId).toBe("session");
    expect(entry.label).toBe("Keep me");
    expect(entry.spawnedBy).toBe("agent:main:dashboard:parent");
    expect(entry.lifecycleRevision).not.toBe("before");
    expect(entry.sessionPromotion).toMatchObject({
      state: "activated",
      basis: "original-basis",
      toLifecycleRevision: entry.lifecycleRevision,
    });
  });

  it("stays pending while an older admission owns the session, then activates after it releases", async () => {
    const scope = await seed();
    const lease = await beginSessionWorkAdmission({
      scope: resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" }).storePath,
      identities: [key, "session"],
      assertAllowed: () => {},
    });
    try {
      expect(
        await activateSessionPromotionBeforeAdmission({ options: human(), sessionKey: key }),
      ).toBe("unchanged");
      const stillOld = loadSessionEntry(scope)!;
      expect(stillOld.lifecycleRevision).toBe("before");
      expect(stillOld.sessionPromotion?.state).toBe("pending");
    } finally {
      lease.release();
    }
    expect(
      await activateSessionPromotionBeforeAdmission({ options: human(), sessionKey: key }),
    ).toBe("activated");
  });

  it("does not take the exclusive promote fence while the session is busy, only when it may activate", async () => {
    const scope = await seed();
    const fence = vi.spyOn(lifecycle, "runExclusiveSessionLifecycleMutation");
    const lease = await beginSessionWorkAdmission({
      scope: resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" }).storePath,
      identities: [key, "session"],
      assertAllowed: () => {},
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(
          await activateSessionPromotionBeforeAdmission({ options: human(), sessionKey: key }),
        ).toBe("unchanged");
      }
      expect(fence.mock.calls.filter(([kind]) => kind === "promote")).toHaveLength(0);
    } finally {
      lease.release();
    }
    expect(
      await activateSessionPromotionBeforeAdmission({ options: human(), sessionKey: key }),
    ).toBe("activated");
    expect(fence.mock.calls.filter(([kind]) => kind === "promote")).toHaveLength(1);
    fence.mockRestore();
  });

  it.each([
    [
      "a persisted pending final delivery",
      { pendingFinalDelivery: { kind: "transport-only", createdAt: 1 } },
    ],
    [
      "an owed delivery notice",
      {
        pendingDeliveryNotice: {
          createdAt: 1,
          context: { channel: "webchat" },
          intentId: "intent",
          state: "owed",
        },
      },
    ],
    [
      "a restart-recovery terminal send in flight",
      { restartRecoveryDeliveryReceiptState: "terminal-pending" },
    ],
    ["a restart-recovery run id", { restartRecoveryDeliveryRunId: "run-recovering" }],
    ["interrupted run generations", { restartRecoveryRuns: [{ runId: "run-old" }] }],
    ["an interrupted run awaiting recovery", { abortedLastRun: true, status: "running" }],
    ["a non-terminal lifecycle run", { lifecycleRunId: "run-yielded" }],
  ] as Array<[string, Partial<SessionEntry>]>)(
    "stays pending after a restart while the row carries %s, then activates once cleared",
    async (_name, obligation) => {
      const scope = await seed(obligation);
      const field = Object.keys(obligation)[0] as keyof SessionEntry;
      expect(
        await activateSessionPromotionBeforeAdmission({ options: human(), sessionKey: key }),
      ).toBe("unchanged");
      const blocked = loadSessionEntry(scope)!;
      expect(blocked.lifecycleRevision).toBe("before");
      expect(blocked.sessionPromotion?.state).toBe("pending");
      await updateResolvedSessionEntry(scope, (entry) => {
        delete entry[field];
      });
      expect(
        await activateSessionPromotionBeforeAdmission({ options: human(), sessionKey: key }),
      ).toBe("activated");
    },
  );

  it("activates right after an explicit Stop even though the stopped turn recorded abortedLastRun", async () => {
    const scope = await seed({ abortedLastRun: true, status: "killed" });
    expect(
      await activateSessionPromotionBeforeAdmission({ options: human(), sessionKey: key }),
    ).toBe("activated");
    expect(loadSessionEntry(scope)?.sessionPromotion?.state).toBe("activated");
  });

  it("does not activate for a different human or a non-human caller", async () => {
    const scope = await seed();
    expect(
      await activateSessionPromotionBeforeAdmission({ options: human("bob"), sessionKey: key }),
    ).toBe("unchanged");
    const synthetic = human();
    (synthetic.client!.internal as Record<string, unknown>).syntheticClient = true;
    expect(
      await activateSessionPromotionBeforeAdmission({ options: synthetic, sessionKey: key }),
    ).toBe("unchanged");
    expect(loadSessionEntry(scope)?.sessionPromotion?.state).toBe("pending");
  });

  it("real owner inventories report no blockers for a quiet session", async () => {
    const scope = await seed();
    const target = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
    const found = await probeSessionPromotionQuiescence({
      context: (human() as unknown as { context: never }).context,
      storePath: target.storePath,
      sessionKey: key,
      sessionKeys: [key],
      sessionId: "session",
      agentId: "main",
      lifecycleIdentities: [key, "session"],
    });
    expect(found.blockers).toEqual([]);
    expect(found.recheck()).toEqual([]);
  });

  it("cancels a pending intent using only the projected original id; a fresh UUID conflicts", async () => {
    const scope = await seed();
    const entry = loadSessionEntry(scope)!;
    const projection = projectSessionPromotion({
      key,
      entry,
      authorize: () => true,
      now: 3,
    });
    expect(projection).toMatchObject({ canCancel: true, pendingRequestId: "request" });
    const cancel = (requestId: string) =>
      requestSessionPromotion({
        scope,
        expectedSessionId: "session",
        expectedLifecycleRevision: "before",
        requester,
        requestId,
        action: "cancel",
        assertCurrent: () => {},
        now: 4,
      });
    await expect(cancel("00000000-0000-4000-8000-000000000001")).rejects.toThrow();
    expect(loadSessionEntry(scope)?.sessionPromotion?.state).toBe("pending");
    expect(await cancel(projection.pendingRequestId!)).toMatchObject({ state: "cancelled" });
    // Idempotent retry after reload returns the same settled intent without a second transition.
    expect(await cancel(projection.pendingRequestId!)).toMatchObject({ state: "cancelled" });
    const after = projectSessionPromotion({
      key,
      entry: loadSessionEntry(scope)!,
      authorize: () => true,
      now: 5,
    });
    expect(after).toMatchObject({ canCancel: false, canPromote: true });
    expect(after).not.toHaveProperty("pendingRequestId");
    expect(
      await activateSessionPromotionBeforeAdmission({ options: human(), sessionKey: key }),
    ).toBe("unchanged");
    expect(loadSessionEntry(scope)?.lifecycleRevision).toBe("before");
  });
});
