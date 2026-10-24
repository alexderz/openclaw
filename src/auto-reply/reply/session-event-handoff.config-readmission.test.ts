import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { publishSessionEntryWorkerInvalidations } from "../../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import * as gatewayWork from "../../process/gateway-work-admission.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { TurnAdoptionLifecycle } from "../get-reply-options.types.js";
import type { ReplyOperation } from "./reply-run-registry.contracts.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import type { SessionEventExecution } from "./session-event-contract.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";

// Upstream #169529: an accepted completion refused because a config publication landed
// before it started is re-admitted under the current policy instead of being dropped.
const dispatch = vi.hoisted(() => vi.fn());
// mock-isolation: The turn body is scripted; admission, target and lease stay real.
vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatch,
}));

const continuation = vi.spyOn(gatewayWork, "runWithGatewayDetachedWorkContinuation");
const sessionKey = "agent:main:dashboard:config-readmission";

type DispatchInput = {
  cfg: OpenClawConfig;
  ctx: { MessageSid?: string };
  replyOptions: {
    internalEventExecution: SessionEventExecution;
    turnAdoptionLifecycle: TurnAdoptionLifecycle;
  };
};

let publications = 0;
/** Each publication changes policy; identical values would be a no-op publication. */
function publishPolicy() {
  setRuntimeConfigSnapshot({
    ...getRuntimeConfigSnapshot(),
    tools: { deny: [`publication-${++publications}`] },
  });
}

async function withSession(
  run: (fixture: { env: NodeJS.ProcessEnv; storePath: string; identity: string }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "session-event-config-readmission" }, async (state) => {
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

/** The active turn accepts the event as a deferred follow-up and keeps its lifecycle. */
function deferToActiveRun(lifecycles: TurnAdoptionLifecycle[]) {
  dispatch.mockImplementationOnce(async ({ replyOptions }: DispatchInput) => {
    const lifecycle = replyOptions.turnAdoptionLifecycle;
    lifecycle.onDeferred?.();
    lifecycles.push(lifecycle);
    return { deferredToActiveRun: true };
  });
}

/** The queue drains the deferred run: execution re-checks its source, then the lifecycle ends. */
function drainRefused(lifecycle: TurnAdoptionLifecycle, execution: SessionEventExecution) {
  try {
    execution.assertCurrent?.();
  } catch {
    // The run is dropped before adoption, so the queue reports abandonment.
  }
  lifecycle.onAbandoned?.();
  lifecycle.onSettled?.();
}

function completeTurn(runId: string) {
  dispatch.mockImplementationOnce(async ({ replyOptions }: DispatchInput) => {
    const execution = replyOptions.internalEventExecution;
    await execution.beforeStart?.();
    execution.onStarted(runId);
    await execution.onTerminal(runId, "completed");
    return { deferredToActiveRun: false };
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

it("re-admits a deferred completion refused by a policy published before it started", async () => {
  await withSession(async ({ env }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    const lifecycles: TurnAdoptionLifecycle[] = [];
    let execution: SessionEventExecution | undefined;
    dispatch.mockImplementationOnce(async (input: DispatchInput) => {
      execution = input.replyOptions.internalEventExecution;
      input.replyOptions.turnAdoptionLifecycle.onDeferred?.();
      lifecycles.push(input.replyOptions.turnAdoptionLifecycle);
      return { deferredToActiveRun: true };
    });
    completeTurn("readmitted-run");
    const receipt = enqueueSessionEventForHost("Exec completed (calm-daisy, code 0)", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
    });
    await expect(receipt.accepted).resolves.toEqual({ ok: true });

    publishPolicy();
    drainRefused(lifecycles[0]!, execution!);

    await expect(receipt.settled).resolves.toMatchObject({
      status: "completed",
      executionStarted: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const [first, second] = dispatch.mock.calls.map(([input]) => input as DispatchInput);
    // A fresh dispatch binds the newly published policy under its own inbound id.
    expect(first?.cfg.tools?.deny).toBeUndefined();
    expect(second?.cfg.tools?.deny).toEqual(["publication-" + publications]);
    expect(second?.ctx.MessageSid).toBe(`${receipt.id}:readmission-1`);
    expect(receipt.cancel()).toBe(false);
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });
});

it("re-admits an undeferred wake refused at execution start by a policy publication", async () => {
  await withSession(async ({ env }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    dispatch.mockImplementationOnce(async ({ replyOptions }: DispatchInput) => {
      const execution = replyOptions.internalEventExecution;
      publishPolicy();
      await expect(execution.beforeStart?.()).rejects.toThrow("configuration changed");
      await execution.onTerminal("refused-run", "failed");
      return { deferredToActiveRun: false };
    });
    completeTurn("readmitted-run");
    const receipt = enqueueSessionEventForHost("Exec completed", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
    });

    await expect(receipt.settled).resolves.toMatchObject({
      status: "completed",
      executionStarted: true,
    });
    await expect(receipt.accepted).resolves.toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

it("does not re-admit after the runner reported model activity", async () => {
  await withSession(async ({ env }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    dispatch.mockImplementationOnce(async ({ replyOptions }: DispatchInput) => {
      const execution = replyOptions.internalEventExecution;
      await execution.beforeStart?.();
      publishPolicy();
      // A refused first activity may already have let the turn run; repeating it is unsafe.
      expect(() => execution.onStarted("active-run")).toThrow("configuration changed");
      await execution.onTerminal("active-run", "failed");
      return { deferredToActiveRun: false };
    });
    const receipt = enqueueSessionEventForHost("Exec completed", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
    });

    await expect(receipt.settled).resolves.toMatchObject({
      status: "failed",
      executionStarted: false,
      error: expect.stringContaining("configuration changed"),
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

it("keeps queue abandonment without a policy refusal terminal", async () => {
  await withSession(async ({ env }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    const lifecycles: TurnAdoptionLifecycle[] = [];
    deferToActiveRun(lifecycles);
    const receipt = enqueueSessionEventForHost("Exec completed", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
    });
    await expect(receipt.accepted).resolves.toEqual({ ok: true });
    // Stop or lifecycle cleanup drops the queued run; a later publication changes nothing.
    lifecycles[0]!.onAbandoned?.();
    publishPolicy();
    lifecycles[0]!.onSettled?.();

    await expect(receipt.settled).resolves.toMatchObject({
      status: "failed",
      executionStarted: false,
      error: expect.stringContaining("abandoned"),
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

it("bounds re-admission under a publication storm", async () => {
  await withSession(async ({ env }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    dispatch.mockImplementation(async ({ replyOptions }: DispatchInput) => {
      const execution = replyOptions.internalEventExecution;
      publishPolicy();
      await execution.beforeStart?.().catch(() => undefined);
      await execution.onTerminal("storm-run", "failed");
      return { deferredToActiveRun: false };
    });
    const receipt = enqueueSessionEventForHost("Exec completed", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
    });

    await expect(receipt.settled).resolves.toMatchObject({
      status: "failed",
      executionStarted: false,
      error: expect.stringContaining("configuration changed"),
    });
    // The original attempt plus two re-admissions, then a terminal failure.
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch.mock.calls.map(([input]) => (input as DispatchInput).ctx.MessageSid)).toEqual([
      receipt.id,
      `${receipt.id}:readmission-1`,
      `${receipt.id}:readmission-2`,
    ]);
    expect(receipt.cancel()).toBe(false);
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });
});

it("forwards producer cancellation to the live re-admitted attempt", async () => {
  await withSession(async ({ env }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    const lifecycles: TurnAdoptionLifecycle[] = [];
    dispatch.mockImplementationOnce(async ({ replyOptions }: DispatchInput) => {
      const execution = replyOptions.internalEventExecution;
      publishPolicy();
      await execution.beforeStart?.().catch(() => undefined);
      await execution.onTerminal("refused-run", "failed");
      return { deferredToActiveRun: false };
    });
    deferToActiveRun(lifecycles);
    const receipt = enqueueSessionEventForHost("Exec completed", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
    });
    await expect(receipt.accepted).resolves.toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledTimes(2);

    expect(receipt.cancel()).toBe(true);
    lifecycles[0]!.onAbandoned?.();
    lifecycles[0]!.onSettled?.();
    await expect(receipt.settled).resolves.toMatchObject({
      status: "cancelled",
      executionStarted: false,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

it("keeps a re-admitted wake refused by a transient generation window retryable (DER-604)", async () => {
  await withSession(async ({ env, storePath, identity }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    // Long idle: no main-thread handle remains to certify a committed re-read.
    await closeOpenClawAgentDatabasesAsync();
    dispatch.mockImplementationOnce(async ({ replyOptions }: DispatchInput) => {
      const execution = replyOptions.internalEventExecution;
      publishPolicy();
      await execution.beforeStart?.().catch(() => undefined);
      await execution.onTerminal("refused-run", "failed");
      return { deferredToActiveRun: false };
    });
    let refusal: unknown;
    dispatch.mockImplementationOnce(async ({ replyOptions }: DispatchInput) => {
      const execution = replyOptions.internalEventExecution;
      await execution.beforeStart?.();
      publishSessionEntryWorkerInvalidations(
        { agentId: "main", storePath, databaseIdentity: identity },
        [sessionKey],
      );
      try {
        execution.assertCurrent?.();
      } catch (error) {
        refusal = error;
      }
      await execution.onTerminal("readmitted-run", "failed");
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
    expect(outcome.retryable).toBe(true);
    expect(refusal).toMatchObject({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

it("commits the producer's adoption once when a publication refuses it after adoption", async () => {
  await withSession(async ({ env }) => {
    const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
    // The normal reply owner that adopts the deferred run.
    const owner = { sessionId: "original-session", abortSignal: new AbortController().signal };
    const registryGet = vi
      .spyOn(replyRunRegistry, "get")
      .mockReturnValue(owner as unknown as ReplyOperation);
    try {
      const lifecycles: TurnAdoptionLifecycle[] = [];
      const executions: SessionEventExecution[] = [];
      dispatch.mockImplementation(async ({ replyOptions }: DispatchInput) => {
        replyOptions.turnAdoptionLifecycle.onDeferred?.();
        lifecycles.push(replyOptions.turnAdoptionLifecycle);
        executions.push(replyOptions.internalEventExecution);
        return { deferredToActiveRun: true };
      });
      let adoptions = 0;
      const receipt = enqueueSessionEventForHost("Exec completed", {
        agentId: "main",
        sessionKey,
        source: "exec",
        expectedTarget: target,
        onAdopted: () => {
          // The durable producer commits, then a publication lands before execution.
          if (++adoptions === 1) {
            publishPolicy();
          }
        },
      });
      await expect(receipt.accepted).resolves.toEqual({ ok: true });
      await expect(lifecycles[0]!.onAdopted()).rejects.toThrow("configuration changed");
      lifecycles[0]!.onAbandoned?.();
      lifecycles[0]!.onSettled?.();
      await vi.waitFor(() => expect(lifecycles).toHaveLength(2));

      await lifecycles[1]!.onAdopted();
      const execution = executions[1]!;
      await execution.beforeStart?.();
      execution.onStarted("readmitted-run");
      await execution.onTerminal("readmitted-run", "completed");
      lifecycles[1]!.onSettled?.();

      await expect(receipt.settled).resolves.toMatchObject({
        status: "completed",
        executionStarted: true,
      });
      expect(adoptions).toBe(1);
    } finally {
      registryGet.mockRestore();
    }
  });
});
