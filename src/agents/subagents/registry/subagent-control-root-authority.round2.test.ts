// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
/** Real promotion commit, failed registry handoff, and a paused child-root read. */
import { expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import * as sessionRead from "../../../config/sessions/session-entry-read-runtime.js";
import { releasePromotedSessionFromSpawner } from "../../../gateway/session-promotion-registry-handoff.js";
import {
  activatePendingSessionPromotion,
  requestSessionPromotion,
} from "../../../sessions/session-promotion.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { killSessionSubagentRuns } from "./subagent-control-kill.js";
import {
  PROMOTED_ROOT_FORMER_PARENT_DENIED,
  detachedRootAuthorizationError,
  retainChildRootProof,
} from "./subagent-control-root-authority.js";
import {
  buildControlledSubagentRunsReadContext,
  killAllControlledSubagentRuns,
} from "./subagent-control.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as registry from "./subagent-registry.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();
const parent = "agent:main:main";

function controller() {
  return {
    controllerSessionKey: parent,
    controllerAgentId: "main",
    callerSessionKey: parent,
    callerIsSubagent: false,
    controlScope: "children" as const,
  };
}

async function seedDelegatedDashboard(params: {
  sessionKey: string;
  sessionId: string;
  revision: string;
  runId: string;
  requesterSessionKey?: string;
  controllerSessionKey?: string;
}) {
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: params.sessionKey,
    defaultSessionId: params.sessionId,
    lifecycleRevision: params.revision,
    updatedAt: 1,
  });
  const stored = loadSessionEntry({ storePath, sessionKey: params.sessionKey });
  if (!stored) {
    throw new Error(`missing session row for ${params.sessionKey}`);
  }
  await replaceSessionEntry(
    { storePath, sessionKey: params.sessionKey },
    {
      ...stored,
      sessionId: params.sessionId,
      lifecycleRevision: params.revision,
      spawnedBy: parent,
      spawnDepth: 1,
      updatedAt: 1,
    },
  );
  await registerSubagentRun({
    runId: params.runId,
    childSessionKey: params.sessionKey,
    requesterSessionKey: params.requesterSessionKey ?? parent,
    controllerSessionKey: params.controllerSessionKey ?? parent,
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: params.runId,
    cleanup: "keep",
    expectsCompletionMessage: false,
    sessionEntry: { sessionId: params.sessionId, lifecycleRevision: params.revision },
  });
  return storePath;
}

async function activateAndFailHandoff(params: {
  sessionKey: string;
  sessionId: string;
  revision: string;
}) {
  const scope = {
    cfg: getRuntimeConfig(),
    agentId: "main",
    env: process.env,
    sessionKey: params.sessionKey,
  };
  const requestId = `round2-${params.sessionKey}`;
  await requestSessionPromotion({
    scope,
    expectedSessionId: params.sessionId,
    expectedLifecycleRevision: params.revision,
    requester: {
      version: 1,
      actor: { kind: "operator", profileId: "human" },
      scopes: ["operator.sessions.write"],
      grant: null,
    },
    requestId,
    assertCurrent: () => {},
    now: 2,
  });
  const release = vi
    .spyOn(registry, "releaseSubagentChildToRoot")
    .mockRejectedValueOnce(new Error("handoff write failed"));
  try {
    const activated = await activatePendingSessionPromotion({
      scope,
      expectedSessionId: params.sessionId,
      expectedLifecycleRevision: params.revision,
      requestId,
      assertCurrent: () => {},
      now: 3,
      probeBlockers: () => [],
    });
    expect(activated.activated).toBe(true);
    await expect(
      releasePromotedSessionFromSpawner({
        childSessionKey: params.sessionKey,
        childSessionId: params.sessionId,
      }),
    ).rejects.toThrow(/handoff write failed/);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    release.mockRestore();
  }
}

it("denies former-parent control after activation when the registry handoff write fails", async () => {
  const child = "agent:main:dashboard:round2-activation";
  const sessionId = "round2-activation-session";
  const revision = "round2-activation-revision";
  const runId = "round2-activation-run";
  const storePath = await seedDelegatedDashboard({
    sessionKey: child,
    sessionId,
    revision,
    runId,
  });
  const abort = vi.fn();
  const handle = createEmbeddedRunHandle({ abort, runId });
  setActiveEmbeddedRun(sessionId, handle, child);
  try {
    await activateAndFailHandoff({ sessionKey: child, sessionId, revision });
    const stored = loadSessionEntry({ storePath, sessionKey: child });
    expect(stored?.promotedFrom).toBeDefined();
    expect(stored?.lifecycleRevision).not.toBe(revision);
    expect(subagentRuns.get(runId)?.childHandoff).toBeUndefined();
    const cfg = getRuntimeConfig();
    const run = subagentRuns.get(runId)!;
    const proof = await retainChildRootProof(cfg, run);
    try {
      expect(detachedRootAuthorizationError(run, proof.assertCurrent())).toBe(
        PROMOTED_ROOT_FORMER_PARENT_DENIED,
      );
    } finally {
      proof.release();
    }
    const listed = await buildControlledSubagentRunsReadContext(parent, "main", cfg);
    try {
      expect(
        listed.commitSync((current) => current.runs.map((entry) => entry.runId)),
      ).not.toContain(runId);
    } finally {
      listed.release();
    }
    const result = await killAllControlledSubagentRuns({
      cfg,
      controller: controller(),
      runs: [run],
    });
    expect(abort).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "error", killed: 0 });
    const retired = await killSessionSubagentRuns({ cfg, sessionKey: parent, agentId: "main" });
    expect(abort).not.toHaveBeenCalled();
    expect(retired).toMatchObject({ killed: 0 });
  } finally {
    clearActiveEmbeddedRun(sessionId, handle, child);
  }
});

it("omits a child that detaches while the next child-root read is suspended", async () => {
  const keyA = "agent:main:dashboard:round2-a";
  const keyB = "agent:main:dashboard:round2-b";
  const runA = "round2-run-a";
  const runB = "round2-run-b";
  const stores = new Map<string, string>();
  stores.set(
    keyA,
    await seedDelegatedDashboard({
      sessionKey: keyA,
      sessionId: "round2-session-a",
      revision: "round2-revision-a",
      runId: runA,
    }),
  );
  stores.set(
    keyB,
    await seedDelegatedDashboard({
      sessionKey: keyB,
      sessionId: "round2-session-b",
      revision: "round2-revision-b",
      runId: runB,
    }),
  );
  const watched = new Set([keyA, keyB]);
  let detachedKey: string | undefined;
  let guard = false;
  const actual = sessionRead.withSessionEntryReadOnlyInWorker;
  const read = vi
    .spyOn(sessionRead, "withSessionEntryReadOnlyInWorker")
    .mockImplementation(async (input, assertCaller, consume, ...rest) => {
      if (guard || detachedKey || !watched.has(input.sessionKey)) {
        return await actual(input, assertCaller, consume, ...rest);
      }
      detachedKey = input.sessionKey;
      guard = true;
      try {
        let captured:
          | {
              read: Parameters<typeof consume>[0];
              owner: Parameters<typeof consume>[1];
            }
          | undefined;
        await actual(input, assertCaller, async (readResult, owner) => {
          captured = { read: readResult, owner };
          return undefined;
        });
        if (!captured) {
          throw new Error("child root read produced no snapshot");
        }
        const sessionId = detachedKey === keyA ? "round2-session-a" : "round2-session-b";
        const revision = detachedKey === keyA ? "round2-revision-a" : "round2-revision-b";
        await activateAndFailHandoff({ sessionKey: detachedKey, sessionId, revision });
        return await consume(captured.read, captured.owner);
      } finally {
        guard = false;
      }
    });
  try {
    const listed = await buildControlledSubagentRunsReadContext(parent, "main", getRuntimeConfig());
    expect(detachedKey).toBeDefined();
    let ids: string[];
    try {
      ids = listed.commitSync((current) => current.runs.map((entry) => entry.childSessionKey));
    } finally {
      listed.release();
    }
    const survivor = detachedKey === keyA ? keyB : keyA;
    expect(ids).not.toContain(detachedKey);
    expect(ids).toContain(survivor);
    const detachedRunId = detachedKey === keyA ? runA : runB;
    expect(subagentRuns.get(detachedRunId)?.childHandoff).toBeUndefined();
    expect(
      loadSessionEntry({ storePath: stores.get(detachedKey!)!, sessionKey: detachedKey! })
        ?.promotedFrom,
    ).toBeDefined();
    expect(
      loadSessionEntry({ storePath: stores.get(survivor)!, sessionKey: survivor })?.promotedFrom,
    ).toBeUndefined();
  } finally {
    read.mockRestore();
  }
});

it("does not let requester key equality adopt a same-key replacement", async () => {
  const child = "agent:main:dashboard:round2-same-key";
  const runId = "round2-same-key-run";
  const storePath = await seedDelegatedDashboard({
    sessionKey: child,
    sessionId: "round2-original-session",
    revision: "round2-original-revision",
    runId,
  });
  await replaceSessionEntry(
    { storePath, sessionKey: child },
    {
      sessionId: "round2-replacement-session",
      lifecycleRevision: "round2-replacement-revision",
      updatedAt: 4,
    },
  );
  const abort = vi.fn();
  const handle = createEmbeddedRunHandle({ abort, runId });
  setActiveEmbeddedRun("round2-replacement-session", handle, child);
  try {
    const result = await killSessionSubagentRuns({
      cfg: getRuntimeConfig(),
      sessionKey: parent,
      agentId: "main",
    });
    expect(abort).not.toHaveBeenCalled();
    expect(result).toMatchObject({ killed: 0 });
    expect(subagentRuns.get(runId)?.endedReason).toBeUndefined();
  } finally {
    clearActiveEmbeddedRun("round2-replacement-session", handle, child);
  }
});

it("denies an independent controller and does not retire self-requester root-own work", async () => {
  const independentKey = "agent:main:dashboard:round2-independent";
  const selfKey = "agent:main:dashboard:round2-self";
  const independentRun = "round2-independent-run";
  const selfRun = "round2-self-run";
  await seedDelegatedDashboard({
    sessionKey: independentKey,
    sessionId: "round2-independent-session",
    revision: "round2-independent-revision",
    runId: independentRun,
    requesterSessionKey: "agent:other:main",
    controllerSessionKey: parent,
  });
  await seedDelegatedDashboard({
    sessionKey: selfKey,
    sessionId: "round2-self-session",
    revision: "round2-self-revision",
    runId: selfRun,
    requesterSessionKey: selfKey,
    controllerSessionKey: parent,
  });
  await activateAndFailHandoff({
    sessionKey: independentKey,
    sessionId: "round2-independent-session",
    revision: "round2-independent-revision",
  });
  await activateAndFailHandoff({
    sessionKey: selfKey,
    sessionId: "round2-self-session",
    revision: "round2-self-revision",
  });
  const cfg = getRuntimeConfig();
  const independent = subagentRuns.get(independentRun)!;
  const self = subagentRuns.get(selfRun)!;
  const independentProof = await retainChildRootProof(cfg, independent);
  const selfProof = await retainChildRootProof(cfg, self);
  try {
    expect(detachedRootAuthorizationError(independent, independentProof.assertCurrent())).toBe(
      PROMOTED_ROOT_FORMER_PARENT_DENIED,
    );
    expect(detachedRootAuthorizationError(self, selfProof.assertCurrent())).toBeUndefined();
  } finally {
    independentProof.release();
    selfProof.release();
  }
  const abort = vi.fn();
  const handle = createEmbeddedRunHandle({ abort, runId: independentRun });
  setActiveEmbeddedRun("round2-independent-session", handle, independentKey);
  try {
    const result = await killAllControlledSubagentRuns({
      cfg,
      controller: controller(),
      runs: [independent, self],
    });
    expect(abort).not.toHaveBeenCalled();
    expect(result.killed).toBe(0);
    expect(subagentRuns.get(independentRun)?.childHandoff).toBeUndefined();
    expect(subagentRuns.get(selfRun)?.childHandoff).toBeUndefined();
  } finally {
    clearActiveEmbeddedRun("round2-independent-session", handle, independentKey);
  }
});

it("denies a root detached after helper return but before snapshot materialization", async () => {
  const child = "agent:main:dashboard:r3-before";
  const sessionId = "r3-before-session";
  const revision = "r3-before-revision";
  const runId = "r3-before-run";
  await seedDelegatedDashboard({ sessionKey: child, sessionId, revision, runId });
  const held = await buildControlledSubagentRunsReadContext(parent, "main", getRuntimeConfig());
  try {
    await activateAndFailHandoff({ sessionKey: child, sessionId, revision });
    for (let pending = held.prepareRead(); pending; pending = held.prepareRead()) await pending;
    expect(held.commitSync((current) => current.runs.map((entry) => entry.runId))).not.toContain(
      runId,
    );
    expect(() => held.assertTargetCurrentSync(runId)).toThrow();
  } finally {
    held.release();
  }
  expect(() => held.commitSync(() => "late")).toThrow(/released/i);
});

it("allows delivery of a committed snapshot after detachment and releases on render throw", async () => {
  const child = "agent:main:dashboard:r3-after";
  const sessionId = "r3-after-session";
  const revision = "r3-after-revision";
  const runId = "r3-after-run";
  await seedDelegatedDashboard({ sessionKey: child, sessionId, revision, runId });
  const held = await buildControlledSubagentRunsReadContext(parent, "main", getRuntimeConfig());
  let snapshot: string;
  try {
    for (let pending = held.prepareRead(); pending; pending = held.prepareRead()) await pending;
    snapshot = held.commitSync((current) => current.runs.map((entry) => entry.runId).join(","));
  } finally {
    held.release();
  }
  expect(snapshot).toContain(runId);
  await activateAndFailHandoff({ sessionKey: child, sessionId, revision });
  expect(await Promise.resolve(snapshot)).toContain(runId);
  expect(() => held.commitSync(() => snapshot)).toThrow(/released/i);
  const fresh = await buildControlledSubagentRunsReadContext(parent, "main", getRuntimeConfig());
  try {
    expect(fresh.commitSync((current) => current.runs.map((entry) => entry.runId))).not.toContain(
      runId,
    );
  } finally {
    fresh.release();
  }
  const syncOnly = await buildControlledSubagentRunsReadContext(parent, "main", getRuntimeConfig());
  try {
    // @ts-expect-error Promise-returning snapshot renderers are forbidden.
    expect(() => syncOnly.commitSync(async () => "not a synchronous snapshot")).toThrow(
      /synchronous/i,
    );
  } finally {
    syncOnly.release();
  }
  const throwing = await buildControlledSubagentRunsReadContext(parent, "main", getRuntimeConfig());
  const released = vi.spyOn(throwing, "release");
  try {
    expect(() =>
      throwing.commitSync<string>(() => {
        throw new Error("renderer failed");
      }),
    ).toThrow("renderer failed");
  } finally {
    throwing.release();
  }
  expect(released).toHaveBeenCalledOnce();
  expect(() => throwing.assertTargetCurrentSync(runId)).toThrow(/released/i);
});
