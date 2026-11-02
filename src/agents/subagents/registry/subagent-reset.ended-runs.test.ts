// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
/** Reset skips ended runs that cannot prove their incarnation, and still fails on live ones. */
import { expect, it, vi } from "vitest";
import { createReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionMutationHandlers } from "../../../gateway/server-methods/sessions-mutations.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { resolveRunOwnedKillTarget } from "./subagent-control-kill-target.js";
import {
  SUBAGENT_KILL_INCARNATION_REQUIRED,
  SUBAGENT_KILL_SESSION_CHANGED,
} from "./subagent-control-session.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentDisplayStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const parentKey = "agent:main:main";
const childKey = (id: string) => "agent:main:subagent:" + id;

async function updateRun(runId: string, update: (draft: SubagentRunRecord) => void): Promise<void> {
  await mutateSubagentRuns([runId], (rows) => {
    const current = rows.get(runId);
    if (!current) {
      throw new Error("Reset fixture run missing");
    }
    const draft = structuredClone(current);
    update(draft);
    return { value: undefined, postimages: new Map([[runId, draft]]) };
  });
}

async function seedParent() {
  return await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: parentKey,
    defaultSessionId: "reset-parent-session",
    lifecycleRevision: "parent-before-reset",
  });
}

async function registerChild(params: {
  id: string;
  sessionKey?: string;
  requesterSessionKey?: string;
  label?: string;
}) {
  const sessionKey = params.sessionKey ?? childKey(params.id);
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: params.id,
    lifecycleRevision: params.id + "-revision",
  });
  await registerSubagentRun({
    runId: params.id,
    childSessionKey: sessionKey,
    // Records the bound child incarnation, as a current launch does.
    sessionEntry: loadSessionEntry({ storePath, sessionKey }),
    requesterSessionKey: params.requesterSessionKey ?? parentKey,
    requesterAgentId: "main",
    requesterDisplayKey: params.requesterSessionKey ?? parentKey,
    task: params.id,
    label: params.label,
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
  return sessionKey;
}

function endRun(draft: SubagentRunRecord) {
  draft.execution = {
    ...draft.execution,
    status: "terminal",
    startedAt: draft.execution.startedAt ?? 1,
    endedAt: 2,
    outcome: { status: "ok" },
  };
  draft.endedReason = SUBAGENT_ENDED_REASON_COMPLETE;
}

/** Rows written before incarnation binding have neither record. */
function dropIncarnation(draft: SubagentRunRecord) {
  delete draft.childSessionIdentity;
  const target = draft.execution.transcriptTarget;
  if (target) {
    draft.execution.transcriptTarget = { ...target, sessionId: undefined, expectedLifecycleRevision: undefined };
  }
}

async function resetParent() {
  const respond = vi.fn();
  const startedAt = Date.now();
  await sessionMutationHandlers["sessions.reset"]!({
    params: { key: parentKey },
    context: createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
    }) as never,
    respond,
    client: { connect: { scopes: ["operator.admin"] } } as never,
    req: { type: "req", id: "reset", method: "sessions.reset" },
    isWebchatConnect: () => false,
  });
  return { respond, elapsedMs: Date.now() - startedAt };
}

function expectResetOk(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
}

it("reset skips an ended legacy run that has no recorded incarnation", async () => {
  const storePath = await seedParent();
  await registerChild({ id: "legacy-ended" });
  await updateRun("legacy-ended", (draft) => {
    endRun(draft);
    dropIncarnation(draft);
  });
  const before = structuredClone(subagentRuns.get("legacy-ended")!);
  expect(resolveRunOwnedKillTarget(before)).toBeUndefined();

  const { respond } = await resetParent();

  expectResetOk(respond);
  expect(loadSessionEntry({ storePath, sessionKey: parentKey })?.lifecycleRevision).not.toBe(
    "parent-before-reset",
  );
  // Nothing was cancelled or rewritten: the ended run keeps its completed outcome.
  expect(subagentRuns.get("legacy-ended")?.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
  expect(subagentRuns.get("legacy-ended")?.killIntent).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: childKey("legacy-ended")})?.sessionId).toBe(
    "legacy-ended",
  );
});

it("reset skips an ended run whose child session was replaced", async () => {
  const storePath = await seedParent();
  const sessionKey = await registerChild({ id: "replaced-ended" });
  await updateRun("replaced-ended", endRun);
  expect(resolveRunOwnedKillTarget(subagentRuns.get("replaced-ended")!)).toMatchObject({
    sessionId: "replaced-ended",
    expectedLifecycleRevision: "replaced-ended-revision",
  });
  await replaceSessionEntry(
    { storePath, sessionKey },
    { sessionId: "replacement-session", updatedAt: Date.now(), lifecycleRevision: "replacement" },
  );

  const { respond } = await resetParent();

  expectResetOk(respond);
  expect(subagentRuns.get("replaced-ended")?.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
  expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
    sessionId: "replacement-session",
    lifecycleRevision: "replacement",
  });
});

it.each([
  { label: "unbound", reason: SUBAGENT_KILL_INCARNATION_REQUIRED },
  { label: "replaced", reason: SUBAGENT_KILL_SESSION_CHANGED },
])("reset still fails on a live $label run and names the cause", async ({ label, reason }) => {
  const storePath = await seedParent();
  const id = "live-" + label;
  const sessionKey = await registerChild({ id, label: "Live " + label + " worker" });
  if (label === "unbound") {
    await updateRun(id, dropIncarnation);
  } else {
    await replaceSessionEntry(
      { storePath, sessionKey },
      { sessionId: "replacement-session", updatedAt: Date.now(), lifecycleRevision: "replacement" },
    );
  }
  expect(subagentRuns.get(id)?.execution.endedAt).toBeUndefined();

  const { respond } = await resetParent();

  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      message: expect.stringMatching(
        new RegExp(
          "^Reset did not complete because some subagent tasks could not be stopped\\..*Cause: .*Live " +
            label +
            " worker: " +
            reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ),
      ),
    }),
  );
  expect(loadSessionEntry({ storePath, sessionKey: parentKey })?.lifecycleRevision).toBe(
    "parent-before-reset",
  );
});

it.each([
  { homeRun: "ended" as const },
  { homeRun: "active" as const },
])("reset leaves a busy durable dashboard child's work running (Home run $homeRun)", async ({
  homeRun,
}) => {
  const storePath = await seedParent();
  const dashboardKey = "agent:main:dashboard:busy-project";
  await registerChild({ id: "dashboard-spawn", sessionKey: dashboardKey });
  await patchSessionEntryCore({ storePath, sessionKey: dashboardKey }, (entry) => ({
    ...entry,
    parentSessionKey: parentKey,
  }));
  if (homeRun === "ended") {
    // The spawn turn Home started ended long ago; the dashboard now runs its own work.
    await updateRun("dashboard-spawn", endRun);
  }
  const abort = vi.fn();
  const handle = createEmbeddedRunHandle({ abort, runId: "dashboard-spawn" });
  setActiveEmbeddedRun("dashboard-spawn", handle, dashboardKey);
  await registerChild({ id: "dashboard-worker", requesterSessionKey: dashboardKey });
  const dashboardTurn = createReplyOperation({
    sessionKey: dashboardKey,
    sessionId: "dashboard-spawn",
    resetTriggered: false,
  });
  const cancel = vi.fn();
  dashboardTurn.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
  dashboardTurn.setPhase("running");
  const dashboardBefore = loadSessionEntry({ storePath, sessionKey: dashboardKey });
  try {
    const { respond, elapsedMs } = await resetParent();

    expectResetOk(respond);
    expect(elapsedMs).toBeLessThan(10_000);
    expect(cancel).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(subagentRuns.get("dashboard-spawn")?.killIntent).toBeUndefined();
    if (homeRun === "active") {
      expect(subagentRuns.get("dashboard-spawn")?.execution.endedAt).toBeUndefined();
    }
    expect(resolveSubagentDisplayStatus(subagentRuns.get("dashboard-worker")!)).not.toBe("killed");
    expect(subagentRuns.get("dashboard-worker")?.killIntent).toBeUndefined();
    expect(subagentRuns.get("dashboard-worker")?.execution.endedAt).toBeUndefined();
    expect(loadSessionEntry({ storePath, sessionKey: dashboardKey })).toEqual(dashboardBefore);
  } finally {
    dashboardTurn.complete();
    clearActiveEmbeddedRun("dashboard-spawn", handle, dashboardKey);
  }
});
