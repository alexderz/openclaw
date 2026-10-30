/** Native task ownership: which input a background task holds, settles, or retires. */
import { PassThrough } from "node:stream";
import type { CliBackendToolPermissionResult } from "openclaw/plugin-sdk/cli-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  collect,
  installClaudeCliRuntimeHarness,
  resultDetail,
} from "./cli-runtime.harness.test-support.js";
import { acceptMessageForTest, closeSessionForTest, executeClaudeCli, handleRequestForTest } from "./cli.runtime.js";

const { createContext, createLiveSession } = installClaudeCliRuntimeHarness();

describe("Claude native task ownership", () => {
  it("does not let an old run notification or acknowledgment clear the new run descendant", async () => {
    const turn = {
      inputUuid: "input-1", inputStarted: true, sawTerminalResult: false,
      controller: new AbortController(), events: new PassThrough({ objectMode: true }),
      foregroundTaskIds: new Set(), foregroundBashToolUseIds: new Set(),
      pendingBackgroundTaskIds: new Set(), taskNotifications: new Map(),
    };
    const session = {
      currentTurn: turn, hasInputLifecycle: false, closed: false,
      taskOwners: new Map(), taskRuns: new Map(), currentTaskOccurrence: new Map(),
      runningDescendants: new Set(), handle: { close: () => {} },
    } as unknown as Parameters<typeof acceptMessageForTest>[0];
    const send = (message: Record<string, unknown>) => acceptMessageForTest(session, message);
    const start = (run_id: string) => ({ type: "system", subtype: "task_started", task_id: "same-task", run_id, task_type: "local_agent", is_backgrounded: true });
    const notify = (run_id: string) => ({ type: "system", subtype: "task_notification", task_id: "same-task", run_id, status: "completed" });
    const ack = (runId: string) => ({ type: "result", subtype: "success", origin: { kind: "task-notification", runId } });

    await send(start("R1"));
    const old = session.taskRuns.get("R1")!;
    await send(notify("R1"));
    // Keep the turn alive while settling R1, as in a continuing parent stream.
    turn.pendingBackgroundTaskIds.add({} as never);
    await send(ack("R1"));
    turn.pendingBackgroundTaskIds.clear();
    expect(old.phase).toBe("acknowledged");
    await send(start("R2"));
    const current = session.taskRuns.get("R2")!;
    expect(turn.pendingBackgroundTaskIds.has(current as never)).toBe(true);
    expect(session.runningDescendants.has(current)).toBe(true);

    await send(notify("R1"));
    await send(ack("R1"));
    expect(current.phase).toBe("running");
    expect(turn.pendingBackgroundTaskIds.has(current as never)).toBe(true);
    expect(session.runningDescendants.has(current)).toBe(true);
    expect(session.currentTaskOccurrence.get("same-task")).toBe(current);

    await send(notify("R2"));
    expect(session.runningDescendants.has(current)).toBe(false);
    expect(turn.pendingBackgroundTaskIds.has(current as never)).toBe(true);
    await send(ack("R2"));
    expect(current.phase).toBe("acknowledged");
    expect(turn.pendingBackgroundTaskIds.has(current as never)).toBe(false);
  });

  it("does not restore a revoked owner when both runs finish and permissions resolve late", async () => {
    const decisions = [createDeferred<CliBackendToolPermissionResult>(), createDeferred<CliBackendToolPermissionResult>()];
    const events = new PassThrough({ objectMode: true });
    const delivered: unknown[] = [];
    events.on("data", (message) => delivered.push(message));
    const turn = {
      context: { requestToolPermission: ({ toolCallId }: { toolCallId?: string }) =>
        decisions[toolCallId === "permission-R1" ? 0 : 1]!.promise },
      inputUuid: "input-1", inputStarted: true, sawTerminalResult: false,
      controller: new AbortController(), events,
      foregroundTaskIds: new Set(), foregroundBashToolUseIds: new Set(),
      pendingBackgroundTaskIds: new Set(), taskNotifications: new Map(),
    };
    const session = {
      currentTurn: turn, hasInputLifecycle: false, closed: false,
      taskOwners: new Map(), taskRuns: new Map(), currentTaskOccurrence: new Map(),
      runningDescendants: new Set(), handle: { close: () => {} },
    } as unknown as Parameters<typeof acceptMessageForTest>[0];
    const send = (message: Record<string, unknown>) => acceptMessageForTest(session, message);
    const notify = (run_id: string) => ({ type: "system", subtype: "task_notification", task_id: "same-task", run_id, status: "completed" });
    const start = (run_id: string) => ({ type: "system", subtype: "task_started", task_id: "same-task", run_id, task_type: "local_agent", is_backgrounded: true });
    const permission = (run: string) => handleRequestForTest(session, {
      subtype: "can_use_tool", tool_name: "Bash", input: {}, tool_use_id: `permission-${run}`,
    }, new AbortController().signal);
    await send(start("R1"));
    const r1 = session.taskRuns.get("R1")!;
    const p1 = permission("R1");
    await send(notify("R1"));
    await send(start("R2"));
    const r2 = session.taskRuns.get("R2")!;
    const p2 = permission("R2");
    expect(r1).not.toBe(r2);
    expect(turn.pendingBackgroundTaskIds.size).toBe(2);
    expect(session.runningDescendants.has(r2)).toBe(true);
    closeSessionForTest(session, new Error("owner revoked"));
    const deliveredBeforeLate = delivered.length;
    decisions[0]!.resolve({ behavior: "allow", updatedInput: {} });
    decisions[1]!.resolve({ behavior: "allow", updatedInput: {} });
    expect(await p1).toMatchObject({ behavior: "deny", toolUseID: "permission-R1" });
    expect(await p2).toMatchObject({ behavior: "deny", toolUseID: "permission-R2" });
    for (const run of ["R1", "R2"]) {
      await send(notify(run));
      await send({ type: "result", subtype: "success", origin: { kind: "task-notification", runId: run } });
    }
    expect(delivered).toHaveLength(deliveredBeforeLate);
    expect(session.closed).toBe(true);
    expect(session.currentTurn).toBeUndefined();
    expect(turn.controller.signal.aborted).toBe(true);
    expect(session.taskRuns.size).toBe(2);
    expect(session.runningDescendants.size).toBe(0);
    expect(turn.pendingBackgroundTaskIds.size).toBe(2); // retired turn's inert bookkeeping
    expect(r1.phase).toBe("notified");
    expect(r2.phase).toBe("running");
  });

  it.each([
    "background-success",
    "background-agent-subagent-bash-completed",
    "background-agent-subagent-bash-stopped",
    "background-parent-stopped-child-completed",
    "background-parent-stopped-child-stopped",
    "background-agent-foreground-bash",
    "background-agent-foreground-bash-run-ids",
  ])("preserves parent result ownership and warm reuse for %s", async (scenario) => {
    const liveSession = createLiveSession();
    const release = createDeferred<CliBackendToolPermissionResult>();
    const decision = { behavior: "deny" as const, message: "Fixture released." };
    const context = await createContext(scenario, {
      liveSession,
      requestToolPermission: () => release.promise,
    });
    const results: Record<string, unknown>[] = [];
    try {
      for await (const record of executeClaudeCli(context)) {
        if (record.type !== "result") {
          continue;
        }
        results.push(record);
        if (results.length === 1) {
          expect(record).toHaveProperty("openclaw_interim_result", true);
          expect(liveSession.current()?.isIdle()).toBe(false);
          release.resolve(decision);
        }
      }
    } finally {
      release.resolve(decision);
    }
    expect(results).toHaveLength(
      scenario.startsWith("background-parent-stopped")
        ? 4
        : scenario === "background-success" || scenario.startsWith("background-agent-foreground")
          ? 2
          : 3,
    );
    for (const result of results.slice(0, -1)) {
      expect(result).toHaveProperty("openclaw_interim_result", true);
    }
    expect(results.at(-1)).not.toHaveProperty("openclaw_interim_result");
    const detail = resultDetail(results);
    expect(detail.finalBackgroundAnswer).toBe(true);
    const handle = liveSession.current();
    expect(handle?.isIdle()).toBe(true);
    const next = resultDetail(await collect({ ...context, prompt: "next input", useResume: true }));
    expect(next).toMatchObject({ pid: detail.pid, turn: 2, user: "next input" });
    expect(liveSession.current()).toBe(handle);
  });

  it.for(["settlement-resumed", "settlement-requeued", "settlement-duplicates", "settlement-inline", "settlement-inline-legacy"])(
    "preserves the restarted Agent completion across an old receipt (%s)",
    async (scenario, { signal }) => {
      const liveSession = createLiveSession();
      const first = createDeferred<CliBackendToolPermissionResult>();
      const second = createDeferred<CliBackendToolPermissionResult>();
      const decision = { behavior: "deny" as const, message: "Fixture released." };
      const context = await createContext(scenario, {
        liveSession,
        requestToolPermission: ({ toolCallId }) =>
          toolCallId === "settlement-first" ? first.promise : second.promise,
      });
      const results: Record<string, unknown>[] = [];
      const running = (async () => {
        for await (const record of executeClaudeCli(context)) {
          if (record.type !== "result") continue;
          results.push(record);
          if (results.length <= 2) {
            expect(record, `result ${results.length}: ${String(record.result)}`).toHaveProperty(
              "openclaw_interim_result", true,
            );
            expect(liveSession.current()?.isIdle()).toBe(false);
            (results.length === 1 ? first : second).resolve(decision);
          }
        }
      })();
      try { await withinTest(running, signal); } finally { first.resolve(decision); second.resolve(decision); }
      expect(results).toHaveLength(3);
      expect(resultDetail([results[0]!]).answer).toBe("initial interim");
      expect(results[1]!.result).toBe("resumed");
      expect(results[2]).not.toHaveProperty("openclaw_interim_result");
      const final = resultDetail(results);
      expect(final.answer).toBe("parent final");
      const handle = liveSession.current();
      expect(handle?.isIdle()).toBe(true);
      const next = resultDetail(await withinTest(collect({ ...context, useResume: true }), signal));
      expect(next).toMatchObject({ answer: "warm input", pid: final.pid });
      expect(liveSession.current()).toBe(handle);
    },
  );

  it("retires a cancelled parent while its resumed occurrence and permission are pending", async ({ signal }) => {
    const liveSession = createLiveSession();
    const controller = new AbortController();
    const secondStarted = createDeferred<void>();
    const second = createDeferred<CliBackendToolPermissionResult>();
    const decision = { behavior: "deny" as const, message: "Fixture released." };
    const context = await createContext("settlement-resumed", {
      liveSession,
      abortSignal: controller.signal,
      requestToolPermission: ({ toolCallId }) => {
        if (toolCallId === "settlement-first") return Promise.resolve(decision);
        secondStarted.resolve();
        return second.promise;
      },
    });
    const outcome = collect(context).catch((error: unknown) => error);
    try {
      await withinTest(secondStarted.promise, signal);
      const oldHandle = liveSession.current();
      expect(oldHandle?.isIdle()).toBe(false);
      controller.abort(new Error("Synthetic parent cancellation."));
      second.resolve(decision);
      expect(await withinTest(outcome, signal)).toBeInstanceOf(Error);
      expect(liveSession.current()).toBeUndefined();
      const next = resultDetail(await withinTest(collect({
        ...context,
        useResume: true,
        abortSignal: AbortSignal.timeout(10_000),
        env: { ...context.env, CLAUDE_FIXTURE_SCENARIO: "normal" },
      }), signal));
      expect(next.turn).toBe(1);
      expect(liveSession.current()).not.toBe(oldHandle);
    } finally {
      controller.abort();
      second.resolve(decision);
    }
  });

  it.each(["local_agent", "local_workflow"])(
    "settles the parent without a nested %s parent-lane receipt",
    async (childType) => {
      const liveSession = createLiveSession();
      const context = await createContext(`nested-child-${childType}`, { liveSession });
      const results: Record<string, unknown>[] = [];
      for await (const record of executeClaudeCli(context)) {
        if (record.type !== "result") {
          continue;
        }
        results.push(record);
        if (results.length === 1) {
          expect(record).toHaveProperty("openclaw_interim_result", true);
        } else {
          // Assert on delivery, not a timeout: the broken owner emits this final
          // answer as interim and then leaves its iterator open indefinitely.
          expect(record).not.toHaveProperty("openclaw_interim_result");
        }
      }
      expect(results).toHaveLength(2);
      const final = resultDetail(results);
      expect(final.answer).toBe("parent final");
      const handle = liveSession.current();
      expect(handle?.isIdle()).toBe(true);
      const next = resultDetail(await collect({ ...context, useResume: true }));
      expect(next).toMatchObject({ answer: "warm input", pid: final.pid });
      expect(liveSession.current()).toBe(handle);
    },
  );

  it.each(["late-child", "late-child-run-ids"])(
    "retires the process when a prior turn's Agent child outlives it for %s",
    async (scenario) => {
      const liveSession = createLiveSession();
      const context = await createContext(scenario, { liveSession });
      const first = resultDetail(await collect({ ...context, prompt: "first input" }));
      expect(first.childLaunched).toBe(true);
      // The child would resume its Agent during a later input and act with that input's
      // tool and MCP authority, so the process cannot stay warm.
      expect(liveSession.current()).toBeUndefined();
      const next = resultDetail(
        await collect({ ...context, prompt: "next input", useResume: true }),
      );
      expect(next).toMatchObject({ childLaunched: true, turn: 1 });
      expect(next.pid).not.toBe(first.pid);
    },
  );

  it.each(["nested-descendant", "nested-descendant-reparented"])(
    "never lends a later warm turn to a descendant that outlived its foreground parent (%s)",
    async (scenario) => {
      const liveSession = createLiveSession();
      const context = await createContext(scenario, { liveSession });
      const first = resultDetail(await collect(context));
      expect(first.parentFinal).toBe(true);
      // The child could resume its Agent under the next input's tool and MCP authority.
      expect(liveSession.current()).toBeUndefined();
      const next = resultDetail(
        await collect({ ...context, prompt: "next input", useResume: true }),
      );
      expect(next).toMatchObject({ parentFinal: true, turn: 1 });
      expect(next.pid).not.toBe(first.pid);
    },
  );

  it.for(["background-bash-captured-stopped", "background-bash-captured-stopped-overlap"])(
    "settles captured 2.1.286 shape for %s with same-process reuse",
    async (scenario, { signal }) => {
      const barrierReached = createDeferred<void>();
      const release = createDeferred<CliBackendToolPermissionResult>();
      const decision = { behavior: "deny" as const, message: "Fixture released." };
      const context = await createContext(scenario, {
        liveSession: createLiveSession(),
        requestToolPermission: async ({ toolCallId, toolInput }) => {
          if (toolCallId !== "captured-release") {
            return { behavior: "allow", updatedInput: toolInput };
          }
          barrierReached.resolve();
          return release.promise;
        },
      });
      let settled = false;
      const running = collect(context).then((records) => {
        settled = true;
        return records;
      });
      void running.catch(() => {});
      try {
        await withinTest(Promise.race([barrierReached.promise, running]), signal);
        expect(settled).toBe(false);
      } finally {
        release.resolve(decision);
      }
      const records = await withinTest(running, signal);
      const results = records.filter((record) => record.type === "result");
      expect(results).toHaveLength(scenario.endsWith("-overlap") ? 2 : 1);
      if (scenario.endsWith("-overlap")) {
        expect(results[0]).toHaveProperty("openclaw_interim_result", true);
      }
      expect(results.at(-1)).not.toHaveProperty("openclaw_interim_result");
      expect(
        records
          .filter((record) => record.subtype === "task_started")
          .every((record) => record.is_backgrounded === true),
      ).toBe(true);
      expect(records.some((record) => record.type === "user" && record.isReplay === true)).toBe(
        false,
      );
      expect(resultDetail(records).capturedShapeAnswered).toBe(true);
      const detail = resultDetail(records);
      expect(context.liveSession?.current()?.isIdle()).toBe(true);
      const next = resultDetail(
        await collect({ ...context, prompt: "next input", useResume: true }),
      );
      expect(next).toMatchObject({ pid: detail.pid, turn: 2, user: "next input" });
    },
  );

  it.for([
    "background-bash-stopped-final",
    "background-bash-stopped-final-run-ids",
    "background-bash-stopped-final-slow",
    "background-bash-stopped-final-slow-run-ids",
  ])(
    "accepts the final answer after a TaskStopped auto-backgrounded Bash for %s",
    async (scenario, { signal }) => {
      const liveSession = createLiveSession();
      const context = await createContext(scenario, {
        liveSession,
        requestToolPermission: async ({ toolInput }) => ({
          behavior: "allow",
          updatedInput: toolInput,
        }),
      });
      // Native sends nothing after this result; holding it would wait for the no-output watchdog.
      const records = await withinTest(collect(context), signal);
      const results = records.filter((record) => record.type === "result");
      expect(results).toHaveLength(1);
      expect(results[0]).not.toHaveProperty("openclaw_interim_result");
      expect(records.at(-2)).toMatchObject({
        type: "assistant",
        message: { stop_reason: "end_turn" },
      });
      const detail = resultDetail(records);
      expect(detail).toMatchObject({ stoppedBashFinal: true, turn: 1 });
      const handle = liveSession.current();
      expect(handle?.isIdle()).toBe(true);
      const next = resultDetail(
        await collect({ ...context, prompt: "next input", useResume: true }),
      );
      expect(next).toMatchObject({ pid: detail.pid, turn: 2, user: "next input" });
      expect(liveSession.current()).toBe(handle);
    },
  );
});
