import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { publishSessionEntryWorkerInvalidations } from "../../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import * as gatewayWork from "../../process/gateway-work-admission.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SessionEventExecution } from "./session-event-contract.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";

// DER-604: an exec completion wake is the only completion signal. A turn refused by a
// transient delivery-generation window before any model activity may be retried.
const dispatch = vi.hoisted(() => vi.fn());
// mock-isolation: The turn body is scripted; admission, target and lease stay real.
vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatch,
}));

const continuation = vi.spyOn(gatewayWork, "runWithGatewayDetachedWorkContinuation");
const sessionKey = "agent:main:dashboard:late-exec-wake";

type DispatchInput = {
  replyOptions: {
    internalEventExecution: SessionEventExecution;
    onReplyOperationOwned?: (operation: { abortSignal: AbortSignal }) => void;
  };
};

async function withSession(
  run: (fixture: { env: NodeJS.ProcessEnv; storePath: string; identity: string }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "session-event-retryable" }, async (state) => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    openOpenClawStateDatabase({ env: state.env });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    writeSessionEntry(database, sessionKey, {
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
      updatedAt: 1,
    });
    const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
    if (typeof identity !== "string") {
      throw new Error("Expected a file-backed agent database identity");
    }
    try {
      await run({ env: state.env, storePath: database.path, identity });
    } finally {
      resetSystemEventsForTest();
      gatewayWork.resetGatewayWorkAdmission();
      await Promise.allSettled(
        continuation.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      );
    }
  });
}

beforeEach(() => {
  dispatch.mockReset();
  continuation.mockClear();
  resetSystemEventsForTest();
  gatewayWork.resetGatewayWorkAdmission();
});

afterAll(() => {
  continuation.mockRestore();
});

it.each([
  { when: "before the model starts", mode: "admission", started: false, retryable: true },
  // A started turn may already have run tools; repeating it could duplicate side effects.
  { when: "after the model started", mode: "started", started: true, retryable: undefined },
  // The runner reports activity before this check; a swallowed refusal may let the turn run.
  {
    when: "at the first reported activity",
    mode: "onStarted",
    started: false,
    retryable: undefined,
  },
  { when: "before start, then aborted", mode: "suppressed", started: false, retryable: undefined },
  {
    when: "before start, then the reply operation stops",
    mode: "operation-aborted",
    started: false,
    retryable: undefined,
  },
] as const)(
  "classifies a wake refused by an uncertifiable generation $when",
  async ({ mode, started, retryable }) => {
    await withSession(async ({ env, storePath, identity }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      // Long idle: no main-thread handle remains to certify a committed re-read.
      await closeOpenClawAgentDatabasesAsync();
      expect(getOpenClawAgentDatabaseIfOpen({ agentId: "main", env })).toBeUndefined();
      let refusal: unknown;
      dispatch.mockImplementationOnce(async ({ replyOptions }: DispatchInput) => {
        const execution = replyOptions.internalEventExecution;
        await execution.beforeStart?.();
        if (mode === "started") {
          execution.onStarted("late-wake-run");
        }
        // A session-row write during admission settles as an unknown worker publication.
        publishSessionEntryWorkerInvalidations(
          { agentId: "main", storePath, databaseIdentity: identity },
          [sessionKey],
        );
        try {
          if (mode === "onStarted") {
            execution.onStarted("late-wake-run");
          } else {
            // Run admission checks the event's source before any model or CLI activity.
            execution.assertCurrent?.();
          }
        } catch (error) {
          refusal = error;
        }
        if (mode === "suppressed") {
          execution.onSuppressed?.("aborted");
        } else if (mode === "operation-aborted") {
          replyOptions.onReplyOperationOwned?.({ abortSignal: AbortSignal.abort() });
        }
        await execution.onTerminal("late-wake-run", "failed");
        return { deferredToActiveRun: false };
      });
      const receipt = enqueueSessionEventForHost("Exec failed (calm-dai, code 1) :: 0", {
        agentId: "main",
        sessionKey,
        source: "exec",
        expectedTarget: target,
      });

      const outcome = await receipt.settled;
      expect(outcome).toMatchObject({
        status: "failed",
        executionStarted: started,
        delivered: false,
      });
      expect(outcome.retryable).toBe(retryable);
      expect(refusal).toMatchObject({
        code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE",
        pending: false,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  },
);

it("does not mark an unstarted wake retryable for a failure that is not a generation window", async () => {
  await withSession(async ({ env }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    dispatch.mockImplementationOnce(async ({ replyOptions }: DispatchInput) => {
      const execution = replyOptions.internalEventExecution;
      await execution.beforeStart?.();
      execution.onFailed?.(new Error("Session event origin is missing"));
      await execution.onTerminal("unstarted-failure-run", "failed");
      return { deferredToActiveRun: false };
    });
    const receipt = enqueueSessionEventForHost("Exec completed", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
    });

    const outcome = await receipt.settled;
    expect(outcome).toMatchObject({ status: "failed", executionStarted: false });
    expect(outcome.retryable).toBeUndefined();
  });
});

it("does not mark a wake retryable after the session generation was replaced", async () => {
  await withSession(async ({ env, storePath }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey, env },
      { sessionId: "replacement-session", lifecycleRevision: "replacement", updatedAt: 2 },
    );
    const receipt = enqueueSessionEventForHost("Exec completed", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
    });

    const outcome = await receipt.settled;
    expect(outcome).toMatchObject({ status: "failed", executionStarted: false });
    expect(outcome.retryable).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it("does not mark a started turn retryable for an ordinary run failure", async () => {
  await withSession(async ({ env }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    dispatch.mockImplementationOnce(async ({ replyOptions }: DispatchInput) => {
      const execution = replyOptions.internalEventExecution;
      await execution.beforeStart?.();
      execution.onStarted("ordinary-failure-run");
      execution.onFailed?.(new Error("provider failed"));
      await execution.onTerminal("ordinary-failure-run", "failed");
      return { deferredToActiveRun: false };
    });
    const receipt = enqueueSessionEventForHost("Exec completed", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
    });

    const outcome = await receipt.settled;
    expect(outcome).toMatchObject({ status: "failed", executionStarted: true });
    expect(outcome.retryable).toBeUndefined();
  });
});

it("does not mark a wake refused by a draining Gateway as retryable", async () => {
  await withSession(async ({ env }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    gatewayWork.markGatewayRestartDraining();
    const receipt = enqueueSessionEventForHost("Exec completed", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
    });

    const outcome = await receipt.settled;
    expect(outcome).toMatchObject({ status: "failed", executionStarted: false });
    expect(outcome.retryable).toBeUndefined();
  });
});
