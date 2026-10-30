import "../../test-utils/prepare-compiled-subprocesses.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "../../config/sessions/session-accessor.reset.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionReplacement from "../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import * as sessionGeneration from "../../config/sessions/session-delivery-generation.js";
import * as sessionEntryRead from "../../config/sessions/session-entry-read-runtime.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueRequiredSystemEventEntry,
  isSystemEventTurnOwned,
  peekDeliverableSystemEventEntries,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import * as gatewayWork from "../../process/gateway-work-admission.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { TurnAdoptionLifecycle } from "../get-reply-options.types.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
  type SessionEventTarget,
} from "./session-event-handoff.js";
import {
  isSessionEventPreparationDeferredError,
  prepareSessionEventTargetForHost,
} from "./session-event-target.js";
// These cases stop before turn admission. Unexpected dispatch is a failure,
// never a synthetic adoption/settlement supplied by the fixture.
const dispatch = vi.hoisted(() =>
  vi.fn<typeof import("../dispatch.js").dispatchInboundMessageWithRoutedChannelDispatcher>(() => {
    throw new Error("Unexpected reply dispatch for a retired event target");
  }),
);
type DispatchResult = Awaited<ReturnType<typeof dispatch>>;
const dispatchResult = (overrides: Partial<DispatchResult> = {}): DispatchResult => ({
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 0 },
  ...overrides,
});
const routeReplyMock = vi.hoisted(() => vi.fn<typeof import("./route-reply.js").routeReply>());
vi.mock("./route-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./route-reply.js")>()),
  routeReply: routeReplyMock,
}));
const eventLogError = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "session-events" ? { ...logger, error: eventLogError } : logger;
    },
  };
});
// mock-isolation: Reject unexpected reply execution; retired-target cases stop before admission.
vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatch,
}));

const continuation = vi.spyOn(gatewayWork, "runWithGatewayDetachedWorkContinuation");
const sessionKey = "agent:main:event-origin";
const route = {
  channel: "telegram",
  to: "-100001",
  accountId: "event-account",
  threadId: "42",
};

async function withTargetFixture(
  run: (fixture: OpenClawTestState & { storePath: string }) => Promise<void>,
  options: { empty?: boolean; native?: boolean } = {},
) {
  await withOpenClawTestState(
    {
      label: "session-event-target",
      ...(options.native ? { env: { OPENCLAW_TEST_FAST: "0" } } : {}),
    },
    async (state) => {
      setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
      openOpenClawStateDatabase({ env: state.env });
      if (!options.empty) {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        writeSessionEntry(database, sessionKey, {
          sessionId: "original-session",
          lifecycleRevision: "original-revision",
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({ context: route }),
          permissionMode: "full",
        });
      }
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env });
      try {
        await run({ ...state, storePath });
      } finally {
        resetSystemEventsForTest();
        gatewayWork.resetGatewayWorkAdmission();
        await Promise.allSettled(
          continuation.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
        expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
      }
    },
  );
}

beforeEach(() => {
  eventLogError.mockClear();
  routeReplyMock.mockReset();
  continuation.mockClear();
  dispatch.mockClear();
  // mockClear keeps persistent implementations; restore the throwing default.
  dispatch.mockImplementation(() => {
    throw new Error("Unexpected reply dispatch for a retired event target");
  });
  resetSystemEventsForTest();
  gatewayWork.resetGatewayWorkAdmission();
});

afterAll(() => {
  continuation.mockRestore();
});

describe("session event target custody", () => {
  it("retains fresh event custody from a captured Windows short-path spelling", async () => {
    await withTargetFixture(
      async (state) => {
        const root = await fs.realpath(state.path());
        const directory = path.join(root, "EVENT~1");
        const canonicalDirectory = path.join(root, "event-store");
        await fs.mkdir(canonicalDirectory);
        await fs.symlink(canonicalDirectory, directory, "junction");
        const storePath = path.join(directory, "event-store.sqlite");
        setRuntimeConfigSnapshot({
          agents: { entries: { main: {} } },
          session: { store: storePath },
        });
        openOpenClawAgentDatabase({ agentId: "main", path: storePath, env: state.env });
        const originalLstat = fsSync.lstatSync;
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        // Windows short directory aliases aren't symlinks; the fixture shares real DB/WAL files.
        const lstat = vi
          .spyOn(fsSync, "lstatSync")
          .mockImplementation((pathname, options) =>
            originalLstat(String(pathname) === directory ? canonicalDirectory : pathname, options),
          );
        const originalRead = sessionEntryRead.withSessionEntryReadOnlyInWorker;
        const readCapturedSpelling: typeof originalRead = (
          input,
          assertCurrent,
          consume,
          prepare,
        ) =>
          originalRead(
            input,
            assertCurrent,
            (read, owner) =>
              consume(read, {
                ...owner,
                // Model the historical spelling in transferred metadata; retain native facts/guards.
                selectedStore: owner.selectedStore && {
                  ...owner.selectedStore,
                  physicalPath: storePath,
                },
              }),
            prepare,
          );
        const reader = vi
          .spyOn(sessionEntryRead, "withSessionEntryReadOnlyInWorker")
          .mockImplementation(readCapturedSpelling);
        let prepared: Awaited<ReturnType<typeof prepareSessionEventTargetForHost>> | undefined;
        try {
          const target = await captureSessionEventTargetForHost("main", sessionKey, {
            env: state.env,
          });
          reader.mockRestore();
          prepared = await prepareSessionEventTargetForHost(target, { createIfMissing: true });
          prepared.assertCurrent();
          const scope = { agentId: "main", storePath, sessionKey, env: state.env };
          const snapshot = await loadReplySessionInitializationSnapshot(scope);
          const committed = await commitReplySessionInitialization({
            ...scope,
            activeSessionKey: sessionKey,
            expectedRevision: snapshot.revision,
            sessionEntry: {
              sessionId: "windows-first-session",
              lifecycleRevision: "first",
              updatedAt: 1,
            },
            bindCreation: prepared.bindCreation,
          });
          expect(committed.ok).toBe(true);
          expect(target).toMatchObject({
            sessionId: "windows-first-session",
            lifecycleRevision: "first",
          });
          prepared.assertCurrent();
        } finally {
          prepared?.release();
          reader.mockRestore();
          lstat.mockRestore();
          platform.mockRestore();
        }
      },
      { empty: true, native: true },
    );
  });

  it.each(["before", "after"] as const)(
    "binds cold event capture to storage created %s the worker read",
    async (creation) => {
      await withTargetFixture(
        async ({ env }) => {
          const create = () => {
            const database = openOpenClawAgentDatabase({ agentId: "main", env });
            writeSessionEntry(database, sessionKey, {
              sessionId: "created-during-capture",
              lifecycleRevision: "created-during-capture",
              updatedAt: 1,
            });
          };
          const originalRead = sessionEntryRead.withSessionEntryReadOnlyInWorker;
          const reader = vi
            .spyOn(sessionEntryRead, "withSessionEntryReadOnlyInWorker")
            .mockImplementation((input, assertCurrent, consume, prepare) =>
              originalRead(
                input,
                assertCurrent,
                async (read, owner) => {
                  if (creation === "after") {
                    create();
                  }
                  return consume(read, owner);
                },
                (database, identity) => {
                  prepare?.(database, identity);
                  expect(identity.key).toMatch(/^path:/);
                  if (creation === "before") {
                    create();
                  }
                },
              ),
            );
          try {
            const capture = captureSessionEventTargetForHost("main", sessionKey, { env });
            if (creation === "after") {
              await expect(capture).rejects.toThrow("storage changed after capture");
              return;
            }
            const target = await capture;
            expect(target).toMatchObject({
              sessionId: "created-during-capture",
              lifecycleRevision: "created-during-capture",
            });
            reader.mockRestore();
            const prepared = await prepareSessionEventTargetForHost(target);
            try {
              prepared.assertCurrent();
            } finally {
              prepared.release();
            }
            expect(dispatch).not.toHaveBeenCalled();
          } finally {
            reader.mockRestore();
          }
        },
        { empty: true, native: true },
      );
    },
  );

  it.for([false, true])(
    "joins cold native preparation before settling cancellation (retained occurrence: %s)",
    async (preserve, { signal }) => {
      await withTargetFixture(
        async ({ env }) => {
          const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
          const prepared = createDeferred();
          const release = createDeferred();
          const cancellation = new AbortController();
          const prepareDatabase = sessionReplacement.prepareSessionEntryReplacementDatabase;
          const preparation = vi
            .spyOn(sessionReplacement, "prepareSessionEntryReplacementDatabase")
            .mockImplementation(async (...args) => {
              await prepareDatabase(...args);
              prepared.resolve();
              cancellation.abort();
              await release.promise;
            });
          const occurrence = preserve
            ? enqueueRequiredSystemEventEntry("Cancelled fresh ingress", { sessionKey })
            : undefined;
          const receipt = enqueueSessionEventForHost("Cancelled fresh ingress", {
            agentId: "main",
            sessionKey,
            source: "plugin",
            expectedTarget: target,
            createIfMissing: true,
            abortSignal: cancellation.signal,
            ...(occurrence
              ? { occurrences: [occurrence], preserveOccurrenceOnRejection: true as const }
              : {}),
          });
          let accepted = false;
          let settled = false;
          void receipt.accepted.then(() => {
            accepted = true;
          });
          void receipt.settled.then(() => {
            settled = true;
          });
          try {
            await withinTest(
              awaitGateBeforeSettlement(
                prepared.promise,
                receipt.settled,
                "event never prepared native storage",
              ),
              signal,
            );
            await Promise.resolve();
            expect(accepted).toBe(false);
            expect(settled).toBe(false);
            if (occurrence) {
              expect(isSystemEventTurnOwned(sessionKey, occurrence)).toBe(true);
            }
          } finally {
            release.resolve();
            preparation.mockRestore();
            await receipt.settled;
          }
          await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
          await expect(receipt.settled).resolves.toMatchObject({
            status: "cancelled",
            executionStarted: false,
            delivered: false,
          });
          if (occurrence) {
            expect(isSystemEventTurnOwned(sessionKey, occurrence)).toBe(false);
            expect(peekSystemEventEntries(sessionKey)).toEqual([occurrence]);
          }
          expect(dispatch).not.toHaveBeenCalled();
        },
        { empty: true, native: true },
      );
    },
  );

  it.each(["fresh", "retained", "revoked", "already-revoked", "foreign"] as const)(
    "keeps cold capture read-only and prepares storage only for authorized fresh work: %s",
    async (kind) => {
      await withTargetFixture(
        async ({ env }) => {
          const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
          const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
          expect(target.sessionId).toBe("");
          await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
          if (kind === "fresh") {
            const prepared = await prepareSessionEventTargetForHost(target, {
              createIfMissing: true,
            });
            try {
              prepared.assertCurrent();
              expect((await fs.stat(databasePath)).isFile()).toBe(true);
              const next = await prepareSessionEventTargetForHost(target, {
                createIfMissing: true,
              });
              next.release();
              prepared.assertCurrent();
            } finally {
              prepared.release();
            }
            return;
          }
          if (kind === "foreign") {
            openOpenClawAgentDatabase({ agentId: "main", env });
          }
          let current = kind !== "already-revoked";
          const enqueue = () =>
            enqueueSessionEventForHost("Fresh ingress", {
              agentId: "main",
              sessionKey,
              source: "plugin",
              expectedTarget: target,
              createIfMissing: kind === "retained" ? undefined : true,
              assertAcceptanceCurrent: () => {
                if (!current) {
                  throw new Error("Submitting ingress was revoked");
                }
              },
            });
          if (kind === "already-revoked") {
            expect(enqueue).toThrow("Submitting ingress was revoked");
            expect(peekSystemEventEntries(sessionKey)).toEqual([]);
            await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
            return;
          }
          const receipt = enqueue();
          current &&= kind !== "revoked";
          const error =
            kind === "retained"
              ? /origin is missing/
              : kind === "revoked"
                ? /ingress was revoked/
                : /storage changed/;
          await expect(receipt.accepted).resolves.toMatchObject({
            ok: false,
            error: expect.stringMatching(error),
          });
          await expect(receipt.settled).resolves.toMatchObject({
            status: "failed",
            executionStarted: false,
          });
          expect(dispatch).not.toHaveBeenCalled();
          if (kind !== "foreign") {
            await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
          }
        },
        { empty: true, native: kind === "fresh" },
      );
    },
  );
  it("captures the original store, route and producer restrictions across asynchronous lookup", async () => {
    await withTargetFixture(async ({ env, path: fixturePath, storePath }) => {
      const suppliedEnv = { ...env };
      const toolsAllow = ["read", "exec"];
      let invocationActive = true;
      let producerActive = true;
      const runId = "event-target-private-producer";
      registerAgentRunContext(runId, { agentId: "main", sessionKey, sessionEventDelivery: false });
      const targetPromise = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          sessionEventToolsAllow: toolsAllow,
          operationalRunInstance: createOperationalRunInstanceRef(runId),
          receiptAuthority: () => invocationActive,
        },
        () =>
          captureSessionEventTargetForHost("main", sessionKey, {
            env: suppliedEnv,
            assertCurrent: () => {
              if (!producerActive) {
                throw new Error("Background producer retired");
              }
            },
          }),
      );
      clearAgentRunContext(runId);
      suppliedEnv.OPENCLAW_STATE_DIR = fixturePath("later-state");
      const target = await targetPromise;
      toolsAllow.push("message");
      invocationActive = false;

      expect(target).toMatchObject({
        agentId: "main",
        sessionKey,
        sessionId: "original-session",
        lifecycleRevision: "original-revision",
        storePath,
        deliveryContext: route,
        deliver: false,
        settings: { permissionMode: "full" },
        toolsAllow: ["read", "exec"],
      });
      // The independently owned producer outlives its creating tool invocation.
      expect(() => assertSessionEventTargetCurrent(target)).not.toThrow();
      producerActive = false;
      expect(() => assertSessionEventTargetCurrent(target)).toThrow("Background producer retired");
      expect(() =>
        enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        }),
      ).toThrow("Background producer retired");
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  });

  it.each(["invocation", "producer"] as const)(
    "refuses a target when its %s retires during asynchronous capture",
    async (owner) => {
      await withTargetFixture(async ({ env }) => {
        let active = true;
        const capture = withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey, receiptAuthority: () => owner !== "invocation" || active },
          () =>
            captureSessionEventTargetForHost("main", sessionKey, {
              env,
              assertCurrent: () => {
                if (owner === "producer" && !active) {
                  throw new Error("Background producer retired");
                }
              },
            }),
        );
        active = false;
        await expect(capture).rejects.toThrow(
          owner === "invocation" ? "no longer owns its invocation" : "Background producer retired",
        );
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it.each(["session reset", "lifecycle replacement"] as const)(
    "rejects a captured target after %s before dispatching a turn",
    async (change) => {
      await withTargetFixture(async ({ env, storePath }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey, env },
          {
            sessionId: change === "session reset" ? "replacement-session" : "original-session",
            lifecycleRevision: "replacement-revision",
            updatedAt: 2,
            delivery: normalizeSessionDeliveryState({
              context: { ...route, to: "replacement-target" },
            }),
          },
        );
        const receipt = enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        });

        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: false,
          delivered: false,
          error: expect.stringContaining("original session generation"),
        });
        expect(dispatch).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it.each(["store replacement", "Gateway restart"] as const)(
    "rejects retained target reuse after %s without creating another occurrence",
    async (change) => {
      await withTargetFixture(async ({ env, path: fixturePath }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        if (change === "store replacement") {
          setRuntimeConfigSnapshot({
            agents: { entries: { main: {} } },
            session: { store: fixturePath("replacement.sqlite") },
          });
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        expect(() =>
          enqueueSessionEventForHost("Process completed", {
            agentId: "main",
            sessionKey,
            source: "exec",
            expectedTarget: target,
          }),
        ).toThrow(change === "store replacement" ? "reset or replaced" : "stale gateway lifecycle");
        expect(dispatch).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      });
    },
  );

  it("re-admits a pending occurrence when a policy publication races admission", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      // The publication lands after enqueue but before admission starts.
      const receipt = enqueueCompletion(target);
      publishDeny(["write", "message"]);
      dispatch.mockImplementationOnce(async (params) => {
        expect(params.cfg?.tools?.deny).toEqual(["write", "message"]);
        params.replyOptions?.internalEventExecution?.onStarted?.("run-test");
        return dispatchResult();
      });

      await expect(receipt.settled).resolves.toMatchObject({
        status: "completed",
        executionStarted: true,
        delivered: false,
      });
      await joinContinuations();
      expect(receipt.cancel()).toBe(false);
      // No failure is reported for a rejected-then-readmitted occurrence.
      expect(eventLogError).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  });

  it("re-admits an accepted deferred occurrence under the current policy after a config publication", async () => {
    const adoptions: TurnAdoptionLifecycle[] = [];
    await withDeferredFixture(adoptions, async (target) => {
      let readmissionDeny: string[] | undefined;
      const operation = beginReplyOwner();
      const receipt = enqueueCompletion(target);
      await expect(receipt.accepted).resolves.toMatchObject({ ok: true });
      if (!adoptions[0]) {
        throw new Error("Expected a deferred turn adoption lifecycle for the accepted occurrence");
      }
      dispatch.mockImplementationOnce(async (params) => {
        readmissionDeny = params.cfg?.tools?.deny;
        params.replyOptions?.internalEventExecution?.onStarted?.("run-test");
        return dispatchResult();
      });
      // The publication lands after acceptance; the queued run still holds the old
      // config, so adoption under the stale policy rejects.
      await rejectLatestAdoption(adoptions, ["write", "message"], operation);

      // The occurrence is re-admitted from scratch and executes under the published policy.
      await expect(receipt.settled).resolves.toMatchObject({
        status: "completed",
        executionStarted: true,
        delivered: false,
      });
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(readmissionDeny).toEqual(["write", "message"]);
      // The completed re-admission consumed the occurrence; nothing waits for a later turn.
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      await joinContinuations();
    });
  });

  it("consumes a deferred occurrence the queue owner abandons, even after a config publication", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      let adoption: TurnAdoptionLifecycle | undefined;
      dispatch.mockImplementationOnce(async (params) => {
        adoption = params.replyOptions?.turnAdoptionLifecycle;
        adoption?.onDeferred?.();
        return dispatchResult({ deferredToActiveRun: "followup" });
      });
      const receipt = enqueueSessionEventForHost("Process completed", {
        agentId: "main",
        sessionKey,
        source: "exec",
        expectedTarget: target,
      });
      await expect(receipt.accepted).resolves.toMatchObject({ ok: true });
      if (!adoption) {
        throw new Error("Expected a deferred turn adoption lifecycle for the accepted occurrence");
      }
      setRuntimeConfigSnapshot({
        ...getRuntimeConfigSnapshot(),
        tools: { deny: ["write", "message"] },
      });

      // Stop removes the queued followup before adoption; abandonment is terminal.
      adoption.onAbandoned?.();
      adoption.onSettled?.();

      await expect(receipt.settled).resolves.toMatchObject({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: expect.stringContaining("abandoned"),
      });
      // No policy re-admission and no passive leak into the next ordinary turn.
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  });

  // Shared drivers: collect each attempt's deferred adoption lifecycle, and reject
  // the latest adoption under a fresh publication exactly as the real queue reports
  // it (a rejected adoption surfaces as abandonment before settlement).
  const collectDeferredAdoptions = (adoptions: TurnAdoptionLifecycle[]) => {
    // Owned retry signal: dispatch resolves the gate awaiting the Nth call, so
    // tests await the retry itself (root AGENTS.md prohibits new polling).
    const gates: { count: number; resolve: () => void }[] = [];
    dispatch.mockImplementation(async (params) => {
      const lifecycle = params.replyOptions?.turnAdoptionLifecycle;
      if (lifecycle) {
        adoptions.push(lifecycle);
        lifecycle.onDeferred?.();
      }
      const called = dispatch.mock.calls.length;
      const all = gates.splice(0);
      all.filter((g) => g.count <= called).forEach((g) => g.resolve());
      gates.push(...all.filter((g) => g.count > called));
      return dispatchResult({ deferredToActiveRun: "followup" });
    });
    return (count: number) =>
      dispatch.mock.calls.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            gates.push({ count, resolve });
          });
  };
  const beginReplyOwner = () =>
    replyRunRegistry.begin({ sessionKey, sessionId: "original-session", resetTriggered: false });
  const publishDeny = (deny: string[]) =>
    setRuntimeConfigSnapshot({ ...getRuntimeConfigSnapshot(), tools: { deny } });
  const rejectLatestAdoption = async (
    adoptions: TurnAdoptionLifecycle[],
    deny: string[],
    operation: { complete: () => void },
  ) => {
    const lifecycle = adoptions[adoptions.length - 1];
    if (!lifecycle) {
      throw new Error("Expected a deferred turn adoption lifecycle for the attempt");
    }
    publishDeny(deny);
    await expect(lifecycle.onAdopted?.()).rejects.toThrow("configuration changed");
    lifecycle.onAbandoned?.();
    lifecycle.onSettled?.();
    operation.complete();
  };
  const joinContinuations = () =>
    Promise.allSettled(
      continuation.mock.results.flatMap((r) => (r.type === "return" ? [r.value] : [])),
    );
  type EnqueueExtras = Partial<
    Omit<
      Parameters<typeof enqueueSessionEventForHost>[1],
      "agentId" | "sessionKey" | "expectedTarget"
    >
  >;
  // One deferred-adoption fixture per case: captured target, collecting dispatch
  // mock, retry gate, and a reply-owner registry reset on exit.
  const withDeferredFixture = (
    adoptions: TurnAdoptionLifecycle[],
    fn: (
      target: SessionEventTarget,
      whenDispatchCalled: (count: number) => Promise<void>,
    ) => Promise<void>,
  ) =>
    withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const whenDispatchCalled = collectDeferredAdoptions(adoptions);
      try {
        await fn(target, whenDispatchCalled);
      } finally {
        replyRunTesting.resetReplyRunRegistry();
      }
    });
  const enqueueCompletion = (target: SessionEventTarget, extras?: EnqueueExtras) =>
    enqueueSessionEventForHost("Process completed", {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget: target,
      ...extras,
    });

  it.each(["after-commit", "before-commit"] as const)(
    "commits the producer once across policy readmission: %s",
    async (publication) => {
      const adoptions: TurnAdoptionLifecycle[] = [];
      await withDeferredFixture(adoptions, async (target, whenDispatchCalled) => {
        let commits = 0;
        let operation = beginReplyOwner();
        const receipt = enqueueCompletion(target, {
          onAdopted: () => {
            commits += 1;
            if (publication === "after-commit") publishDeny(["write", "message"]);
          },
        });
        await expect(receipt.accepted).resolves.toMatchObject({ ok: true });
        const original = expectDefined(peekSystemEventEntries(sessionKey)[0], "owned occurrence");
        expect(original.id).toBe(receipt.id);
        if (publication === "before-commit") publishDeny(["write", "message"]);
        await expect(adoptions[0]?.onAdopted?.()).rejects.toThrow("configuration changed");
        expect(commits).toBe(publication === "after-commit" ? 1 : 0);
        adoptions[0]?.onAbandoned?.();
        adoptions[0]?.onSettled?.();
        operation.complete();
        await whenDispatchCalled(2);
        expect(peekSystemEventEntries(sessionKey)[0]?.id).toBe(receipt.id);
        expect(dispatch.mock.calls[1]?.[0].cfg?.tools?.deny).toEqual(["write", "message"]);
        operation = beginReplyOwner();
        await adoptions[1]?.onAdopted?.();
        expect(commits).toBe(1);
        dispatch.mock.calls[1]?.[0].replyOptions?.internalEventExecution?.onStarted?.("run-test");
        adoptions[1]?.onSettled?.();
        operation.complete();
        await expect(receipt.settled).resolves.toMatchObject({ status: "completed", executionStarted: true });
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        await joinContinuations();
      });
    },
  );

  it("does not replay a producer callback that publishes policy and fails", async () => {
    const adoptions: TurnAdoptionLifecycle[] = [];
    await withDeferredFixture(adoptions, async (target) => {
      const operation = beginReplyOwner();
      const onAdopted = vi.fn(() => {
        publishDeny(["write"]);
        throw new Error("producer commit outcome unknown");
      });
      const receipt = enqueueCompletion(target, { onAdopted });
      await expect(receipt.accepted).resolves.toMatchObject({ ok: true });
      await expect(adoptions[0]?.onAdopted?.()).rejects.toThrow("producer commit outcome unknown");
      adoptions[0]?.onAbandoned?.();
      adoptions[0]?.onSettled?.();
      operation.complete();
      await expect(receipt.settled).resolves.toMatchObject({ status: "failed", executionStarted: false });
      expect(onAdopted).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      await joinContinuations();
    });
  });

  it("consumes a canceled re-admission instead of preserving it for a later turn", async () => {
    const adoptions: TurnAdoptionLifecycle[] = [];
    await withDeferredFixture(adoptions, async (target, whenDispatchCalled) => {
      const operation = beginReplyOwner();
      const onAdopted = vi.fn();
      const receipt = enqueueCompletion(target, { onAdopted });
      await expect(receipt.accepted).resolves.toMatchObject({ ok: true });
      await rejectLatestAdoption(adoptions, ["write", "message"], operation);
      await whenDispatchCalled(2);

      // The producer cancels the still-deferred re-admission.
      expect(receipt.cancel()).toBe(true);
      adoptions[1]?.onAbandoned?.();
      adoptions[1]?.onSettled?.();

      await expect(receipt.settled).resolves.toMatchObject({
        status: "cancelled",
        executionStarted: false,
      });
      // Terminal cancellation consumes the retried occurrence: no passive leak.
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(onAdopted).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      await joinContinuations();
    });
  });

  it("settles terminally after the bounded re-admission budget is exhausted", async () => {
    const adoptions: TurnAdoptionLifecycle[] = [];
    await withDeferredFixture(adoptions, async (target, whenDispatchCalled) => {
      let operation = beginReplyOwner();
      const receipt = enqueueCompletion(target);
      await expect(receipt.accepted).resolves.toMatchObject({ ok: true });
      // Three consecutive publications reject the occurrence and both retries.
      for (const deny of [["write"], ["write", "message"], ["write", "message", "exec"]]) {
        await rejectLatestAdoption(adoptions, deny, operation);
        if (adoptions.length < 3) {
          await whenDispatchCalled(adoptions.length + 1);
          // A completed owner leaves the registry; the next attempt adopts a fresh one.
          operation = beginReplyOwner();
        }
      }

      await expect(receipt.settled).resolves.toMatchObject({
        status: "failed",
        executionStarted: false,
      });
      expect(dispatch).toHaveBeenCalledTimes(3);
      // The exhausted occurrence is consumed with a loud error; no passive leak.
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(eventLogError).toHaveBeenCalledWith(
        "session event policy readmission attempts exhausted; occurrence settled",
        expect.objectContaining({ source: "exec", eventId: receipt.id }),
      );
      await joinContinuations();
    });
  });

  it("settles terminally when the producer retires before re-admission", async () => {
    const adoptions: TurnAdoptionLifecycle[] = [];
    await withDeferredFixture(adoptions, async (target) => {
      let retired = false;
      const onAdopted = vi.fn();
      const operation = beginReplyOwner();
      const receipt = enqueueCompletion(target, {
        onAdopted,
        assertCurrent: () => {
          if (retired) {
            throw new Error("producer retired");
          }
        },
      });
      await expect(receipt.accepted).resolves.toMatchObject({ ok: true });
      publishDeny(["write", "message"]);
      const lifecycle = adoptions[0];
      await expect(lifecycle?.onAdopted?.()).rejects.toThrow("configuration changed");
      lifecycle?.onAbandoned?.();
      // The retired producer makes settlement's re-dispatch reject synchronously.
      retired = true;
      lifecycle?.onSettled?.();
      operation.complete();

      await expect(receipt.settled).resolves.toMatchObject({
        status: "failed",
        executionStarted: false,
      });
      // The rejected re-admission consumes the occurrence; no passive leak.
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(onAdopted).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(eventLogError).toHaveBeenCalledWith(
        "session event policy readmission rejected; occurrence settled",
        expect.objectContaining({ source: "exec", eventId: receipt.id }),
      );
      await joinContinuations();
    });
  });

  it("carries submitting authority into a pre-acceptance re-admission and settles on revocation", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      // The first post-publication check runs inside the rejected admission; the
      // second is the re-dispatch, which revoked ingress must reject.
      let publicationObserved = false;
      let postPublicationChecks = 0;
      const ingressAssertion = vi.fn(() => {
        if (publicationObserved) {
          postPublicationChecks += 1;
          if (postPublicationChecks >= 2) {
            throw new Error("submitting ingress revoked");
          }
        }
      });
      const onAdopted = vi.fn();
      const receipt = enqueueSessionEventForHost("Process completed", {
        agentId: "main",
        sessionKey,
        source: "hook",
        expectedTarget: target,
        assertAcceptanceCurrent: ingressAssertion,
        onAdopted,
      });
      // A publication races admission: the first attempt rejects pre-acceptance.
      publishDeny(["write", "message"]);
      publicationObserved = true;

      await expect(receipt.settled).resolves.toMatchObject({
        status: "failed",
        executionStarted: false,
      });
      await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
      // Revoked ingress rejected the re-dispatch before any new turn admission;
      // the occurrence was consumed rather than parked as passive text.
      expect(dispatch).not.toHaveBeenCalled();
      expect(onAdopted).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(eventLogError).toHaveBeenCalledWith(
        "session event policy readmission rejected; occurrence settled",
        expect.objectContaining({ source: "hook", eventId: receipt.id }),
      );
      await joinContinuations();
    });
  });

  it("settles a pending occurrence as cancelled when ephemeral queues close", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const suspension = gatewayWork.tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      try {
        const receipt = enqueueSessionEventForHost("Process completed", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
        });
        expect(peekSystemEventEntries(sessionKey).map((event) => event.id)).toEqual([receipt.id]);
        resetSystemEventsForTest();

        await expect(receipt.settled).resolves.toMatchObject({
          status: "cancelled",
          executionStarted: false,
          delivered: false,
        });
        await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
        expect(receipt.cancel()).toBe(false);
        expect(gatewayWork.getGatewaySuspendAdmissionPhase()).toBe("prepared");
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(dispatch).not.toHaveBeenCalled();
        expect(eventLogError).not.toHaveBeenCalled();
      } finally {
        suspension?.release();
      }
    });
  });

  it.each(["reject", "cancel", "removed"] as const)(
    "preserves a preexisting passive occurrence only after pre-adoption settlement: %s",
    async (boundary) => {
      await withTargetFixture(async ({ env }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        const occurrence = enqueueRequiredSystemEventEntry("Deferred hook", { sessionKey });
        expect(occurrence).not.toBeNull();
        if (!occurrence) {
          throw new Error("Expected deferred hook occurrence");
        }
        if (boundary === "reject") {
          gatewayWork.markGatewayRestartDraining();
        }
        const receipt = enqueueSessionEventForHost(occurrence.text, {
          agentId: "main",
          sessionKey,
          source: "hook",
          expectedTarget: target,
          occurrences: [occurrence],
          preserveOccurrenceOnRejection: true,
        });
        if (boundary === "cancel") {
          expect(receipt.cancel()).toBe(true);
        } else if (boundary === "removed") {
          resetSystemEventsForTest();
        }
        await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
        await expect(receipt.settled).resolves.toMatchObject({
          status: boundary === "reject" ? "failed" : "cancelled",
          executionStarted: false,
        });
        expect(isSystemEventTurnOwned(sessionKey, occurrence)).toBe(false);
        expect(peekSystemEventEntries(sessionKey)).toEqual(
          boundary === "removed" ? [] : [occurrence],
        );
        expect(dispatch).not.toHaveBeenCalled();
      });
    },
  );

  it("releases an occurrence when Gateway restart admission refuses the producer", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      gatewayWork.markGatewayRestartDraining();
      const receipt = enqueueSessionEventForHost("Process completed", {
        agentId: "main",
        sessionKey,
        source: "restart",
        expectedTarget: target,
      });

      await expect(receipt.settled).resolves.toMatchObject({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: expect.stringContaining("GatewayDrainingError"),
      });
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("preserves policy readmission without restarting storage backoff after dispatch", async () => {
    const adoptions: TurnAdoptionLifecycle[] = [];
    await withDeferredFixture(adoptions, async (target) => {
      const operation = beginReplyOwner();
      const receipt = enqueueCompletion(target, { preAdmissionRetry: "exec-completion-storage" });
      await expect(receipt.accepted).resolves.toMatchObject({ ok: true });
      const event = expectDefined(peekSystemEventEntries(sessionKey)[0], "accepted occurrence");
      expect(event.id).toBe(receipt.id);
      const entered = createDeferred();
      const release = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: expectDefined(target.storePath, "captured store"),
        identities: [sessionKey, target.sessionId],
        kind: "compaction",
        run: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      await entered.promise;
      let sameOccurrenceReadmitted = false;
      const prepare = vi
        .spyOn(sessionGeneration, "prepareSessionGenerationFacts")
        .mockImplementationOnce(async () => {
          const retained = expectDefined(
            peekSystemEventEntries(sessionKey)[0],
            "readmitted occurrence",
          );
          expect(retained.id).toBe(receipt.id);
          expect(isSystemEventTurnOwned(sessionKey, retained)).toBe(true);
          sameOccurrenceReadmitted = true;
          throw Object.assign(new Error("later generation unavailable"), {
            code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE",
          });
        });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await rejectLatestAdoption(adoptions, ["write"], operation);
        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: false,
        });
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(sameOccurrenceReadmitted).toBe(true);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        vi.useRealTimers();
        prepare.mockRestore();
        release.resolve();
        await mutation;
      }
    });
  });

  it("waits for the original dispatch owner settlement before disposing an uncertain occurrence", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const operation = beginReplyOwner();
      const dispatched = createDeferred();
      dispatch.mockImplementationOnce(async (params) => {
        params.replyOptions?.onReplyOperationOwned?.(operation);
        dispatched.resolve();
        return dispatchResult();
      });
      try {
        const receipt = enqueueCompletion(target, { preAdmissionRetry: "exec-completion-storage" });
        await dispatched.promise;
        let settled = false;
        void receipt.settled.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        const event = expectDefined(peekSystemEventEntries(sessionKey)[0], "owner occurrence");
        expect(event.id).toBe(receipt.id);
        expect(isSystemEventTurnOwned(sessionKey, event)).toBe(true);
        operation.complete();
        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: false,
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        operation.complete();
        replyRunTesting.resetReplyRunRegistry();
      }
    });
  });
});

describe("exec completion compaction preparation", () => {
  it("emits only a host-origin marker under a compaction gate", async () => {
    await withTargetFixture(async ({ env, storePath }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const started = createDeferred();
      const release = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: [sessionKey, target.sessionId],
        kind: "compaction",
        run: async () => {
          started.resolve();
          await release.promise;
        },
      });
      await started.promise;
      const prepareFacts = vi.spyOn(sessionGeneration, "prepareSessionGenerationFacts");
      try {
        let refusal: unknown;
        try {
          await prepareSessionEventTargetForHost(target, { deferOnCompactionStorageGate: true });
        } catch (error) {
          refusal = error;
        }
        expect(isSessionEventPreparationDeferredError(refusal)).toBe(true);
        expect(prepareFacts).not.toHaveBeenCalled();
        expect(
          isSessionEventPreparationDeferredError(
            Object.assign(
              new Error("Session event preparation deferred by compaction storage gate"),
              { reason: "compaction-storage-gate" },
            ),
          ),
        ).toBe(false);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        prepareFacts.mockRestore();
        release.resolve();
        await mutation;
      }
    });
  });

  it("keeps one occurrence owned during the gate and cancels its timer immediately", async () => {
    await withTargetFixture(async ({ env, storePath }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const started = createDeferred();
      const release = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: [sessionKey, target.sessionId],
        kind: "compaction",
        run: async () => {
          started.resolve();
          await release.promise;
        },
      });
      await started.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const receipt = enqueueSessionEventForHost("completion", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
          preAdmissionRetry: "exec-completion-storage",
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        const events = peekSystemEventEntries(sessionKey);
        expect(events).toHaveLength(1);
        expect(isSystemEventTurnOwned(sessionKey, expectDefined(events[0], "owned event"))).toBe(
          true,
        );
        receipt.cancel();
        await expect(receipt.settled).resolves.toMatchObject({ status: "cancelled" });
        expect(vi.getTimerCount()).toBe(0);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        await vi.advanceTimersByTimeAsync(3600000);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        release.resolve();
        await mutation;
      }
    });
  });

  it("exhausts two bounded waits without dispatch or leaving the occurrence", async () => {
    await withTargetFixture(async ({ env, storePath }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const started = createDeferred();
      const release = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: [sessionKey, target.sessionId],
        kind: "compaction",
        run: async () => {
          started.resolve();
          await release.promise;
        },
      });
      await started.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const timers = vi.spyOn(globalThis, "setTimeout");
      try {
        const receipt = enqueueSessionEventForHost("completion", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
          preAdmissionRetry: "exec-completion-storage",
        });
        await vi.advanceTimersByTimeAsync(0);
        const event = expectDefined(peekSystemEventEntries(sessionKey)[0], "owned event");
        expect(event).toBeDefined();
        expect(isSystemEventTurnOwned(sessionKey, event)).toBe(true);
        await vi.advanceTimersByTimeAsync(250);
        expect(expectDefined(peekSystemEventEntries(sessionKey)[0], "owned event").id).toBe(
          event.id,
        );
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        await expect(receipt.settled).resolves.toMatchObject({ status: "failed" });
        expect(vi.getTimerCount()).toBe(0);
        expect(
          timers.mock.calls
            .map((args) => args[1])
            .filter((delay) => delay === 250 || delay === 1000),
        ).toEqual([250, 1000]);
        expect(peekDeliverableSystemEventEntries(sessionKey)).toEqual([]);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(eventLogError).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3600000);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        timers.mockRestore();
        vi.useRealTimers();
        release.resolve();
        await mutation;
      }
    });
  });

  it("dispatches the original occurrence once when the compaction gate opens", async () => {
    await withTargetFixture(async ({ env, storePath }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const started = createDeferred();
      const release = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: [sessionKey, target.sessionId],
        kind: "compaction",
        run: async () => {
          started.resolve();
          await release.promise;
        },
      });
      await started.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const receipt = enqueueSessionEventForHost("completion", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
          preAdmissionRetry: "exec-completion-storage",
        });
        await vi.advanceTimersByTimeAsync(0);
        const event = expectDefined(peekSystemEventEntries(sessionKey)[0], "owned event");
        expect(isSystemEventTurnOwned(sessionKey, event)).toBe(true);
        expect(event.id).toBe(receipt.id);
        expect(peekDeliverableSystemEventEntries(sessionKey)).toEqual([]);
        const { drainFormattedSystemEvents } = await import("./session-system-events.js");
        await expect(
          drainFormattedSystemEvents({
            cfg: getRuntimeConfigSnapshot() ?? {},
            agentId: "main",
            sessionKey,
            isMainSession: false,
            isNewSession: false,
          }),
        ).resolves.toBeUndefined();
        expect(peekSystemEventEntries(sessionKey)[0]?.id).toBe(receipt.id);
        expect(isSystemEventTurnOwned(sessionKey, event)).toBe(true);
        let accepted = false;
        void receipt.accepted.then(() => {
          accepted = true;
        });
        await Promise.resolve();
        expect(accepted).toBe(false);
        dispatch.mockImplementationOnce(async (params) => {
          expect(params.ctx.MessageSid).toBe(event.id);
          expect(params.ctx.SessionKey).toBe(sessionKey);
          params.replyOptions?.internalEventExecution?.onStarted?.("wake-test");
          return dispatchResult();
        });
        release.resolve();
        await mutation;
        await vi.advanceTimersByTimeAsync(250);
        vi.useRealTimers();
        await expect(receipt.settled).resolves.toMatchObject({
          status: "completed",
          executionStarted: true,
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        vi.useRealTimers();
        release.resolve();
        await mutation;
      }
    });
  });

  it.each(["cancel", "removal", "request abort"] as const)(
    "withdraws the original waiting occurrence on %s without advancing the clock",
    async (withdrawal) => {
      await withTargetFixture(async ({ env, storePath }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        const entered = createDeferred();
        const release = createDeferred();
        const mutation = runExclusiveSessionLifecycleMutation("patch", {
          scope: storePath,
          identities: [sessionKey, target.sessionId],
          kind: "compaction",
          run: async () => {
            entered.resolve();
            await release.promise;
          },
        });
        await entered.promise;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const controller = new AbortController();
          const receipt = enqueueSessionEventForHost("completion", {
            agentId: "main",
            sessionKey,
            source: "exec",
            expectedTarget: target,
            preAdmissionRetry: "exec-completion-storage",
            abortSignal: controller.signal,
          });
          await vi.advanceTimersByTimeAsync(0);
          const event = expectDefined(peekSystemEventEntries(sessionKey)[0], "waiting occurrence");
          expect(event.id).toBe(receipt.id);
          expect(isSystemEventTurnOwned(sessionKey, event)).toBe(true);
          expect(peekDeliverableSystemEventEntries(sessionKey)).toEqual([]);
          if (withdrawal === "cancel") {
            expect(receipt.cancel()).toBe(true);
            expect(receipt.cancel()).toBe(false);
          } else if (withdrawal === "removal") {
            expect(consumeSelectedSystemEventEntries(sessionKey, [event])).toHaveLength(1);
          } else {
            controller.abort();
          }
          await expect(receipt.settled).resolves.toMatchObject({
            status: "cancelled",
            executionStarted: false,
          });
          expect(vi.getTimerCount()).toBe(0);
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
          await vi.advanceTimersByTimeAsync(3600000);
          expect(dispatch).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
          release.resolve();
          await mutation;
        }
      });
    },
  );

  it.each([
    "ingress",
    "producer",
    "generation",
    "session replacement",
    "destination move",
  ] as const)("does not dispatch or retarget when %s changes during backoff", async (change) => {
    await withTargetFixture(async ({ env, storePath, path: fixturePath }) => {
      let live = true;
      const target = await captureSessionEventTargetForHost("main", sessionKey, {
        env,
        assertCurrent: () => {
          if (change === "producer" && !live) throw new Error("producer retired");
        },
      });
      const entered = createDeferred();
      const release = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: [sessionKey, target.sessionId],
        kind: "compaction",
        run: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      await entered.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const receipt = enqueueSessionEventForHost("completion", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
          preAdmissionRetry: "exec-completion-storage",
          assertAcceptanceCurrent: () => {
            if (change === "ingress" && !live) throw new Error("ingress revoked");
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        const event = expectDefined(peekSystemEventEntries(sessionKey)[0], "waiting occurrence");
        expect(event.id).toBe(receipt.id);
        expect(isSystemEventTurnOwned(sessionKey, event)).toBe(true);
        release.resolve();
        await mutation;
        live = false;
        if (change === "generation") rotateAgentEventLifecycleGeneration();
        if (change === "destination move") {
          setRuntimeConfigSnapshot({
            agents: { entries: { main: {} } },
            session: { store: fixturePath("new-dashboard.sqlite") },
          });
        }
        if (change === "session replacement") {
          replaceSessionEntrySync(
            { agentId: "main", storePath, sessionKey, env },
            {
              sessionId: "replacement-session",
              lifecycleRevision: "replacement",
              updatedAt: 2,
              delivery: normalizeSessionDeliveryState({
                context: { ...route, to: "new-dashboard" },
              }),
            },
          );
        }
        await vi.advanceTimersByTimeAsync(250);
        await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: false,
        });
        expect(dispatch).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
        release.resolve();
        await mutation;
      }
    });
  });

  it("never retries an uncertain dispatch after the dispatch boundary", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const entered = createDeferred();
      const release = createDeferred();
      dispatch.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        throw new Error("unknown dispatch result");
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const receipt = enqueueSessionEventForHost("completion", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
          preAdmissionRetry: "exec-completion-storage",
        });
        await entered.promise;
        const event = expectDefined(peekSystemEventEntries(sessionKey)[0], "dispatch occurrence");
        expect(event.id).toBe(receipt.id);
        await vi.advanceTimersByTimeAsync(3600000);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        release.resolve();
        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: false,
        });
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        vi.useRealTimers();
      }
    });
  });

  it("rejects retry opt-in without an existing captured exec target", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      for (const options of [
        { source: "hook" as const, expectedTarget: target },
        { source: "exec" as const },
        { source: "exec" as const, expectedTarget: target, createIfMissing: true as const },
        { source: "exec" as const, expectedTarget: { ...target } },
      ]) {
        expect(() =>
          enqueueSessionEventForHost("completion", {
            agentId: "main",
            sessionKey,
            preAdmissionRetry: "exec-completion-storage",
            ...options,
          }),
        ).toThrow("existing host-captured target");
      }
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it.each([
    [
      "generation unavailable",
      Object.assign(new Error("generation unavailable"), {
        code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE",
      }),
    ],
    [
      "wrapped generation unavailable",
      new Error("wrapper", {
        cause: Object.assign(new Error("generation unavailable"), {
          code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE",
        }),
      }),
    ],
    ["busy", Object.assign(new Error("busy"), { code: "SQLITE_BUSY" })],
    ["locked", Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" })],
    ["worker timeout", new Error("worker timeout")],
    ["worker disconnected", new Error("worker disconnected")],
    ["unknown worker result", new Error("unknown worker result")],
    ["ordinary error", new Error("ordinary failure")],
  ])("does not retry %s from generation preparation", async (_name, error) => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const prepare = vi
        .spyOn(sessionGeneration, "prepareSessionGenerationFacts")
        .mockRejectedValueOnce(error);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const receipt = enqueueSessionEventForHost("completion", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
          preAdmissionRetry: "exec-completion-storage",
        });
        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: false,
        });
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(dispatch).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        vi.useRealTimers();
        prepare.mockRestore();
      }
    });
  });

  it.each(["promotion", "mixed"] as const)(
    "does not mint a compaction marker for %s lifecycle gates",
    async (kind) => {
      await withTargetFixture(async ({ env, storePath }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        const entered = createDeferred();
        const release = createDeferred();
        const promote = runExclusiveSessionLifecycleMutation("patch", {
          scope: storePath,
          identities: [sessionKey],
          kind: "promote",
          run: async () => {
            entered.resolve();
            await release.promise;
          },
        });
        await entered.promise;
        const secondEntered = createDeferred();
        const compaction =
          kind === "mixed"
            ? runExclusiveSessionLifecycleMutation("patch", {
                scope: storePath,
                identities: [target.sessionId],
                kind: "compaction",
                run: async () => {
                  secondEntered.resolve();
                  await release.promise;
                },
              })
            : undefined;
        if (compaction) await secondEntered.promise;
        try {
          let error: unknown;
          let lease: Awaited<ReturnType<typeof prepareSessionEventTargetForHost>> | undefined;
          try {
            lease = await prepareSessionEventTargetForHost(target, {
              deferOnCompactionStorageGate: true,
            });
          } catch (caught) {
            error = caught;
          } finally {
            lease?.release();
          }
          expect(isSessionEventPreparationDeferredError(error)).toBe(false);
        } finally {
          release.resolve();
          await promote;
          await compaction;
        }
      });
    },
  );

  it("rejects a replaced physical source during backoff without minting a retry marker", async () => {
    await withTargetFixture(async ({ env, storePath }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      const entered = createDeferred();
      const release = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation("patch", {
        scope: storePath,
        identities: [sessionKey, target.sessionId],
        kind: "compaction",
        run: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      await entered.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const receipt = enqueueSessionEventForHost("completion", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
          preAdmissionRetry: "exec-completion-storage",
        });
        await vi.advanceTimersByTimeAsync(0);
        const event = expectDefined(peekSystemEventEntries(sessionKey)[0], "waiting event");
        expect(isSystemEventTurnOwned(sessionKey, event)).toBe(true);
        const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
        await fs.rename(databasePath, `${databasePath}.original`);
        await fs.writeFile(databasePath, "replacement");
        let failure: unknown;
        try {
          await prepareSessionEventTargetForHost(target, { deferOnCompactionStorageGate: true });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        expect(isSessionEventPreparationDeferredError(failure)).toBe(false);
        release.resolve();
        await mutation;
        await vi.advanceTimersByTimeAsync(250);
        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: false,
        });
        expect(dispatch).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        vi.useRealTimers();
        release.resolve();
        await mutation;
      }
    });
  });

  it("does not re-enqueue after model start followed by dispatch uncertainty", async () => {
    await withTargetFixture(async ({ env }) => {
      const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
      dispatch.mockImplementationOnce(async (params) => {
        params.replyOptions?.internalEventExecution?.onStarted?.("started-run");
        throw Object.assign(new Error("generation unavailable after start"), {
          code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE",
        });
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const receipt = enqueueSessionEventForHost("completion", {
          agentId: "main",
          sessionKey,
          source: "exec",
          expectedTarget: target,
          preAdmissionRetry: "exec-completion-storage",
        });
        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: true,
        });
        await vi.advanceTimersByTimeAsync(3600000);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it.each(["delivered", "uncertain"] as const)(
    "retains the original route and performs one %s delivery after the gate",
    async (delivery) => {
      await withTargetFixture(async ({ env, storePath }) => {
        const target = await captureSessionEventTargetForHost("main", sessionKey, { env });
        const entered = createDeferred();
        const release = createDeferred();
        const mutation = runExclusiveSessionLifecycleMutation("patch", {
          scope: storePath,
          identities: [sessionKey, target.sessionId],
          kind: "compaction",
          run: async () => {
            entered.resolve();
            await release.promise;
          },
        });
        await entered.promise;
        routeReplyMock.mockImplementationOnce(async (params) => {
          await params.beforeDeliver?.();
          return delivery === "delivered"
            ? { ok: true, delivered: true }
            : { ok: false, delivered: true, ambiguous: true, error: "uncertain transport" };
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const receipt = enqueueSessionEventForHost("completion", {
            agentId: "main",
            sessionKey,
            source: "exec",
            expectedTarget: target,
            preAdmissionRetry: "exec-completion-storage",
          });
          await vi.advanceTimersByTimeAsync(0);
          const event = expectDefined(peekSystemEventEntries(sessionKey)[0], "waiting occurrence");
          expect(event.id).toBe(receipt.id);
          expect(peekDeliverableSystemEventEntries(sessionKey)).toEqual([]);
          dispatch.mockImplementationOnce(async (params) => {
            expect(params.ctx.MessageSid).toBe(event.id);
            expect(params.ctx.OriginatingTo).toBe(route.to);
            expect(params.replyOptions?.admittedSessionSettings).toEqual(target.settings);
            expect(params.replyOptions?.toolsAllow).toEqual(target.toolsAllow);
            params.replyOptions?.internalEventExecution?.onStarted?.("delivery-run");
            await params.dispatcherOptions.deliver(
              { text: "completion result" },
              { kind: "final" },
            );
            return dispatchResult();
          });
          release.resolve();
          await mutation;
          await vi.advanceTimersByTimeAsync(250);
          vi.useRealTimers();
          await expect(receipt.settled).resolves.toMatchObject({
            status: delivery === "delivered" ? "completed" : "failed",
            executionStarted: true,
            delivered: true,
            deliveryAttempted: true,
            ...(delivery === "uncertain" ? { deliveryAmbiguous: true } : {}),
          });
          expect(dispatch).toHaveBeenCalledTimes(1);
          expect(routeReplyMock).toHaveBeenCalledTimes(1);
          expect(routeReplyMock).toHaveBeenCalledWith(
            expect.objectContaining({
              sessionKey,
              channel: route.channel,
              to: route.to,
              accountId: route.accountId,
              threadId: route.threadId,
            }),
          );
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        } finally {
          vi.useRealTimers();
          release.resolve();
          await mutation;
        }
      });
    },
  );
});
