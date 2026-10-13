import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
  CliBackendToolPermissionResult,
} from "openclaw/plugin-sdk/cli-backend";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasClaudeRawToolInvocation } from "./cli-output.js";
import type { ClaudeCliSecretInput } from "./cli-process.js";
import { prepareClaudeCliTransportArgs } from "./cli-runtime-args.js";
import { isDescendantTask, readReplayedTaskId, recordTaskOwnership, type NativeTaskOccurrence } from "./cli-runtime-tasks.js";
import { createClaudeCliTransport } from "./cli-transport.js";
import { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

const IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

type ClaudeCliTurn = {
  context: CliBackendExecuteContext;
  controller: AbortController;
  userInput: ReturnType<typeof createClaudeCliUserInputAuthorizer>;
  events: PassThrough;
  inputUuid: string;
  /** Replayed user text is never a task receipt, even after its input lifecycle ends. */
  submittedInputUuids: Set<string>;
  inputStarted: boolean;
  promptSubmitted: boolean;
  /** Hook reruns carry no input UUID and may rewrite text; retain their native input owner. */
  promptInputUuid: string;
  sawTerminalResult: boolean;
  foregroundTaskIds: Set<NativeTaskOccurrence>;
  foregroundBashToolUseIds: Set<string>;
  pendingBackgroundTaskIds: Set<NativeTaskOccurrence>;
  taskNotifications: Map<NativeTaskOccurrence, "queued" | "replayed">;
  /** Same-turn inputs written to native, keyed by UUID until their lifecycle completes. */
  injectedInputs: Map<
    string,
    {
      text: string;
      started: ReturnType<typeof createDeferred<void>>;
    }
  >;
  /**
   * A successful result withheld until every injected input has completed. It is
   * released as terminal on completion, or as interim when native opens another
   * turn for the input first.
   */
  heldResult?: Record<string, unknown>;
  error?: Error;
};
type ClaudeCliSession = {
  handle: CliBackendLiveSessionHandle;
  capability?: CliBackendLiveSessionCapability;
  transport?: ReturnType<typeof createClaudeCliTransport>;
  currentTurn?: ClaudeCliTurn;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasInputLifecycle: boolean;
  closed: boolean;
  // Tasks outlive inputs; false marks subagent work with no parent-stream query.
  taskOwners: Map<string, string | false>;
  // Native notification results identify task runs rather than task IDs.
  taskRuns: Map<string, NativeTaskOccurrence>;
  currentTaskOccurrence: Map<string, NativeTaskOccurrence>;
  // Running Agent/Workflow tasks and subagent-owned work, at any depth, until notified.
  runningDescendants: Set<NativeTaskOccurrence>;
};
const sessions = new WeakMap<CliBackendLiveSessionHandle, ClaudeCliSession>();

function activeTurn(session: ClaudeCliSession): ClaudeCliTurn | undefined {
  const turn = session.currentTurn;
  if (!turn || turn.controller.signal.aborted || turn.context.abortSignal?.aborted) {
    return undefined;
  }
  // A warm child can emit prior-input callbacks while the next admitted input is queued.
  if (session.hasInputLifecycle && !turn.inputStarted) {
    return undefined;
  }
  try {
    turn.context.assertCurrent?.();
    return turn;
  } catch {
    return undefined;
  }
}

async function authorizeTool(
  session: ClaudeCliSession,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CliBackendToolPermissionResult> {
  const turn = activeTurn(session);
  const { input, tool_name: toolName } = request;
  if (!turn || signal.aborted || typeof toolName !== "string" || !isRecord(input)) {
    return {
      behavior: "deny",
      message: "The OpenClaw run or native tool input is no longer valid.",
    };
  }
  const toolUseId = typeof request.tool_use_id === "string" ? request.tool_use_id : undefined;
  const abortSignal = AbortSignal.any([signal, turn.controller.signal]);
  try {
    const decision =
      toolName === "AskUserQuestion"
        ? await turn.userInput.authorize({ input, signal: abortSignal, toolUseId })
        : await turn.context.requestToolPermission({
            toolName,
            toolInput: input,
            cwd: typeof request.cwd === "string" ? request.cwd : undefined,
            toolCallId: toolUseId,
            abortSignal,
          });
    // An operator decision can outlive its turn. Revalidate immediately before granting it.
    if (activeTurn(session) !== turn || abortSignal.aborted) {
      return { behavior: "deny", message: "The OpenClaw run is no longer active." };
    }
    if (
      decision.behavior === "allow" &&
      toolName === "Bash" &&
      toolUseId &&
      decision.updatedInput.run_in_background !== true
    ) {
      // Native may first announce an automatic timeout as already backgrounded.
      // The authorized input distinguishes it from explicit run_in_background work.
      turn.foregroundBashToolUseIds.add(toolUseId);
    }
    return decision;
  } catch {
    return { behavior: "deny", message: "OpenClaw could not authorize this tool call." };
  }
}

function isInjectedPrompt(turn: ClaudeCliTurn, prompt: unknown): boolean {
  if (turn.promptInputUuid !== turn.inputUuid) {
    return true;
  }
  // Some native versions submit hooks before the started receipt. Match only the
  // first pass; subsequent passes belong to that UUID even when text is rewritten.
  const injected = [...turn.injectedInputs].find(([, input]) => input.text === prompt);
  if (!injected) {
    return false;
  }
  turn.promptInputUuid = injected[0];
  return true;
}

async function handleRequest(
  session: ClaudeCliSession,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  if (request.subtype === "can_use_tool") {
    return { ...(await authorizeTool(session, request, signal)), toolUseID: request.tool_use_id };
  }
  if (request.subtype !== "hook_callback" || !isRecord(request.input)) {
    throw new Error("Unsupported Claude CLI control request.");
  }
  const input = request.input;
  const turn = activeTurn(session);
  if (request.callback_id === "UserPromptSubmit" && input.hook_event_name === "UserPromptSubmit") {
    if (!turn || signal.aborted || isInjectedPrompt(turn, input.prompt)) {
      return {};
    }
    turn.promptSubmitted = true;
    const additionalContext = [
      turn.context.promptContext?.prependContext,
      turn.context.promptContext?.appendContext,
    ]
      .filter(Boolean)
      .join("\n\n");
    // Native can rewrite the prompt and rerun hooks; only its final pass is persisted.
    return additionalContext
      ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }
      : {};
  }
  if (request.callback_id === "PreToolUse" && input.hook_event_name === "PreToolUse") {
    if (
      turn &&
      !signal.aborted &&
      typeof input.tool_name === "string" &&
      input.tool_name.startsWith("mcp__openclaw__")
    ) {
      return { continue: true };
    }
    // Native settings can grant tools before can_use_tool. This hook preserves host policy.
    const decision = await authorizeTool(
      session,
      {
        tool_name: input.tool_name,
        input: input.tool_input,
        cwd: input.cwd,
        tool_use_id: request.tool_use_id ?? input.tool_use_id,
      },
      signal,
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.behavior,
        ...(decision.behavior === "allow"
          ? { updatedInput: decision.updatedInput }
          : { permissionDecisionReason: decision.message }),
      },
    };
  }
  throw new Error("Unknown Claude CLI hook callback.");
}

function createUserInput(context: CliBackendExecuteContext, text: string, uuid: string) {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid,
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
  };
}

function rejectInjectedInputs(turn: ClaudeCliTurn, error: Error) {
  for (const input of turn.injectedInputs.values()) {
    input.started.reject(error);
  }
}

async function injectInput(
  session: ClaudeCliSession,
  turn: ClaudeCliTurn,
  text: string,
  withCurrent: (submit: () => void) => Promise<void>,
): Promise<void> {
  const uuid = randomUUID();
  const started = createDeferred<void>();
  // Closing can reject the receipt while the write is still pending.
  void started.promise.catch(() => {});
  let written: Promise<void> | undefined;
  await withCurrent(() => {
    // Native lifecycle is the receipt; recheck availability after host preparation.
    if (
      !session.hasInputLifecycle ||
      !session.transport ||
      !turn.promptSubmitted ||
      activeTurn(session) !== turn
    ) {
      throw new Error("The Claude CLI turn cannot accept more input.");
    }
    turn.injectedInputs.set(uuid, { text, started });
    turn.submittedInputUuids.add(uuid);
    written = session.transport.send(createUserInput(turn.context, text, uuid));
    // Host admission cleanup may await after the synchronous write.
    void written.catch(() => {});
  });
  if (!written) {
    throw new Error("The host did not admit Claude CLI input.");
  }
  try {
    await written;
  } catch (error) {
    turn.injectedInputs.delete(uuid);
    throw error;
  }
  await started.promise;
}

function closeSession(session: ClaudeCliSession, error?: unknown) {
  if (session.closed) {
    return;
  }
  session.closed = true;
  clearTimeout(session.idleTimer);
  session.capability?.remove(session.handle);
  const turn = session.currentTurn;
  session.currentTurn = undefined;
  if (turn) {
    turn.error = toErrorObject(error, "Claude CLI live session closed.");
    rejectInjectedInputs(turn, turn.error);
    turn.controller.abort();
    turn.events.end();
  }
  session.transport?.close();
}

function completeTurn(session: ClaudeCliSession, turn: ClaudeCliTurn) {
  // Nested Agent and Workflow descendants can outlive their foreground parent without a
  // parent-lane receipt. A warm process would lend them the next turn's tool and MCP authority.
  const holdsBackgroundTasks =
    turn.pendingBackgroundTaskIds.size > 0 || session.runningDescendants.size > 0;
  session.currentTurn = undefined;
  // Unfinished injected input would run as an orphan native turn; the host replays it instead.
  const orphanedInput = turn.injectedInputs.size > 0;
  rejectInjectedInputs(
    turn,
    new Error("Claude CLI turn ended before its injected input completed."),
  );
  turn.controller.abort();
  turn.events.end();
  if (!session.capability || holdsBackgroundTasks || orphanedInput) {
    // A failed parent does not stop native background continuations. Never lend them a new turn.
    // Input written into a turn that ended unanswered is the same kind of debt.
    session.handle.close(holdsBackgroundTasks || orphanedInput ? "abort" : "idle");
  } else {
    session.idleTimer = setTimeout(() => session.handle.close("idle"), IDLE_TIMEOUT_MS);
    session.idleTimer.unref();
  }
}

async function emitHeldInterimResult(turn: ClaudeCliTurn) {
  const heldResult = turn.heldResult;
  if (!heldResult) {
    return;
  }
  turn.heldResult = undefined;
  if (!turn.events.write({ ...heldResult, openclaw_interim_result: true })) {
    await once(turn.events, "drain", { signal: turn.controller.signal });
  }
}

async function acceptMessage(session: ClaudeCliSession, message: Record<string, unknown>) {
  if (message.type === "system" && message.subtype === "init") {
    session.hasInputLifecycle =
      Array.isArray(message.capabilities) && message.capabilities.includes("msg_lifecycle_v1");
  }
  const turn = session.currentTurn;
  const input = turn && (!session.hasInputLifecycle || turn.inputStarted) ? turn : undefined;
  let occurrence: NativeTaskOccurrence | undefined;
  if (message.type === "system") {
    const startedTasks = message.subtype === "task_started" ? [message]
      : message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)
        ? message.tasks.filter(isRecord) : [];
    for (const task of startedTasks) {
      const current = typeof task.task_id === "string" ? session.currentTaskOccurrence.get(task.task_id) : undefined;
      const item = recordTaskOwnership(session, task, input?.inputUuid ?? "", true,
        message.subtype === "task_started" && current?.phase !== "running");
      if (!item || item.phase !== "running") continue;
      if (isDescendantTask(task)) {
        session.runningDescendants.add(item);
      }
      if (task === message) occurrence = item;
      if (input && item.ownerInputUuid === input.inputUuid &&
        (((task.task_type === "local_agent" || task.task_type === "local_workflow") &&
          (message.subtype === "background_tasks_changed" || task.is_backgrounded === true)) ||
          (task.task_type === "local_bash" && input.foregroundTaskIds.has(item)))) {
        input.pendingBackgroundTaskIds.add(item);
      }
    }
    if (message.subtype === "task_notification") {
      occurrence = recordTaskOwnership(session, message, input?.inputUuid ?? "", false, false);
      if (occurrence && occurrence.phase === "running") {
        session.runningDescendants.delete(occurrence);
      }
    }
  }
  if (!turn) return;
  if (message.type === "command_lifecycle") {
    if (message.state === "started" && message.command_uuid === turn.inputUuid) turn.inputStarted = true;
    const injectedUuid =
      typeof message.command_uuid === "string" ? message.command_uuid : undefined;
    const injected = injectedUuid ? turn.injectedInputs.get(injectedUuid) : undefined;
    if (injected && injectedUuid && message.state === "started") {
      turn.promptInputUuid = injectedUuid;
      injected.started.resolve();
      await emitHeldInterimResult(turn);
    } else if (
      injected &&
      injectedUuid &&
      (message.state === "completed" ||
        message.state === "cancelled" ||
        message.state === "discarded" ||
        message.state === "refused")
    ) {
      // Discarded/refused inputs never run; cancellation can also precede start.
      // Already-started receipts stay accepted, so terminal cleanup never replays them.
      if (message.state === "completed") {
        // Native may omit started on a terminal receipt; completion still proves consumption.
        injected.started.resolve();
      } else {
        injected.started.reject(new Error(`Claude CLI ${message.state} the injected input.`));
      }
      turn.injectedInputs.delete(injectedUuid);
      if (turn.promptInputUuid === injectedUuid) {
        turn.promptInputUuid = turn.inputUuid;
      }
      const heldResult = turn.heldResult;
      // Same completion rule as a result: no held background work or queued notification.
      if (
        heldResult &&
        turn.injectedInputs.size === 0 &&
        turn.pendingBackgroundTaskIds.size === 0 &&
        turn.taskNotifications.size === 0
      ) {
        turn.heldResult = undefined;
        if (!turn.events.write(heldResult)) {
          await once(turn.events, "drain", { signal: turn.controller.signal });
        }
        completeTurn(session, turn);
      }
    }
    return;
  }
  if (session.hasInputLifecycle && !turn.inputStarted &&
    !(message.type === "system" && message.subtype === "init")) return;
  if (message.type === "system" && message.subtype === "task_started" && occurrence &&
    occurrence.phase === "running" && occurrence.ownerInputUuid === turn.inputUuid) {
    if (message.is_backgrounded === false) turn.foregroundTaskIds.add(occurrence);
    const foregroundBash = typeof message.tool_use_id === "string" &&
      turn.foregroundBashToolUseIds.delete(message.tool_use_id);
    if (foregroundBash && message.is_backgrounded === true) turn.pendingBackgroundTaskIds.add(occurrence);
  }
  const replayedTaskId = readReplayedTaskId(message, turn.submittedInputUuids);
  if (replayedTaskId) {
    const origin = isRecord(message.origin) ? message.origin : undefined;
    const explicitRun = typeof origin?.runId === "string" ? origin.runId : undefined;
    const replayed = explicitRun ? session.taskRuns.get(explicitRun)
      : [...turn.taskNotifications.keys()].find((item) => item.taskId === replayedTaskId);
    if (replayed && replayed.taskId === replayedTaskId && replayed.ownerInputUuid === turn.inputUuid &&
      replayed.phase === "notified" && turn.taskNotifications.has(replayed)) {
      turn.taskNotifications.set(replayed, "replayed");
    }
  }
  if (message.type === "system" && message.subtype === "task_notification" && occurrence &&
    occurrence.phase === "running") {
    occurrence.phase = "notified";
    if (occurrence.ownerInputUuid === turn.inputUuid) {
      if (message.status === "stopped") {
        occurrence.phase = "acknowledged";
        turn.pendingBackgroundTaskIds.delete(occurrence);
        turn.foregroundTaskIds.delete(occurrence);
        turn.taskNotifications.delete(occurrence);
      } else if (turn.foregroundTaskIds.has(occurrence) && !turn.pendingBackgroundTaskIds.has(occurrence)) {
        occurrence.phase = "acknowledged";
        turn.foregroundTaskIds.delete(occurrence);
      } else {
        turn.taskNotifications.set(occurrence, "queued");
      }
    }
  }
  let completesTurn = false;
  let holdsForInput = false;
  if (message.type === "result") {
    const failed = message.is_error === true ||
      (typeof message.subtype === "string" && message.subtype.startsWith("error")) ||
      (typeof message.result === "string" && hasClaudeRawToolInvocation(message.result));
    const origin = isRecord(message.origin) ? message.origin : undefined;
    const taskNotification = origin?.kind === "task-notification" && origin.subkind === undefined;
    const explicitRun = taskNotification && typeof origin?.runId === "string" ? origin.runId : undefined;
    const notified = taskNotification ? (explicitRun ? session.taskRuns.get(explicitRun)
      : turn.taskNotifications.keys().next().value) : undefined;
    // Explicit identities are never allowed to fall through to an unrelated FIFO slot.
    if (explicitRun && (!notified || notified.ownerInputUuid !== turn.inputUuid ||
      notified.phase !== "notified" || !turn.taskNotifications.has(notified))) return;
    // Only another input start or answer supersedes a held result. Idle/status
    // trailers are bookkeeping, and a prior input's continuation returned above.
    await emitHeldInterimResult(turn);
    if (taskNotification && message.subtype === "success" && !failed && notified) {
      notified.phase = "acknowledged";
      turn.taskNotifications.delete(notified);
      turn.pendingBackgroundTaskIds.delete(notified);
      turn.foregroundTaskIds.delete(notified);
    }
    const queuedContinuation = turn.sawTerminalResult && taskNotification && message.num_turns === 0 &&
      message.result === "" && message.stop_reason === null && message.terminal_reason === undefined;
    for (const [replayed, state] of turn.taskNotifications) {
      if (state === "replayed" && (!explicitRun || replayed === notified)) {
        replayed.phase = "acknowledged";
        turn.taskNotifications.delete(replayed);
        turn.pendingBackgroundTaskIds.delete(replayed);
        turn.foregroundTaskIds.delete(replayed);
      }
    }
    turn.sawTerminalResult = true;
    completesTurn = (turn.pendingBackgroundTaskIds.size === 0 && turn.taskNotifications.size === 0 && !queuedContinuation) || failed;
    // Injected input holds a successful result until its lifecycle says whether it was the last.
    holdsForInput = completesTurn && !failed && turn.injectedInputs.size > 0;
  }
  if (holdsForInput) {
    turn.heldResult = message;
    return;
  }

  // The transport owns continuation lifetime; the completed answer can be
  // delivered through normal reply hooks without waiting for the children.
  const outputMessage =
    message.type === "result" && !completesTurn
      ? { ...message, openclaw_interim_result: true }
      : message;
  if (!turn.events.write(outputMessage)) {
    await once(turn.events, "drain", { signal: turn.controller.signal });
  }
  if (completesTurn) {
    completeTurn(session, turn);
  }
}

// Expose the actual reducer to isolated ownership regression tests.
export const acceptMessageForTest = acceptMessage;
export const closeSessionForTest = closeSession;
export const handleRequestForTest = handleRequest;

function createSession(capability?: CliBackendLiveSessionCapability): ClaudeCliSession {
  const session: ClaudeCliSession = {
    capability,
    hasInputLifecycle: false,
    closed: false,
    taskOwners: new Map(),
    taskRuns: new Map(),
    currentTaskOccurrence: new Map(),
    runningDescendants: new Set(),
    handle: {
      generation: randomUUID(),
      fingerprint: capability?.fingerprint ?? randomUUID(),
      isIdle: () => !session.closed && !session.currentTurn,
      close: (_reason, error) => closeSession(session, error),
      waitForExit: () => session.transport?.waitForExit() ?? Promise.resolve(),
    },
  };
  sessions.set(session.handle, session);
  capability?.register(session.handle);
  return session;
}

export async function* executeClaudeCli(
  context: CliBackendExecuteContext,
  secretInput?: ClaudeCliSecretInput,
): AsyncIterable<Record<string, unknown>> {
  context.assertCurrent?.();
  context.abortSignal?.throwIfAborted();
  const capability = context.liveSession;
  const existing = capability?.current();
  const reusable =
    existing && existing.fingerprint === capability?.fingerprint
      ? sessions.get(existing)
      : undefined;
  if (!reusable && capability) {
    await capability.restart();
  }
  context.assertCurrent?.();
  const session = reusable ?? createSession(capability);
  session.capability = capability;
  if (session.closed || session.currentTurn) {
    throw new Error("Claude CLI live session is closed or already handling another turn.");
  }
  clearTimeout(session.idleTimer);
  const inputUuid = randomUUID();
  const turn: ClaudeCliTurn = {
    context,
    controller: new AbortController(),
    userInput: createClaudeCliUserInputAuthorizer(context),
    events: new PassThrough({ objectMode: true }),
    inputUuid,
    submittedInputUuids: new Set([inputUuid]),
    inputStarted: false,
    promptSubmitted: false,
    promptInputUuid: inputUuid,
    sawTerminalResult: false,
    foregroundTaskIds: new Set(),
    foregroundBashToolUseIds: new Set(),
    pendingBackgroundTaskIds: new Set(),
    injectedInputs: new Map(),
    taskNotifications: new Map(),
  };
  session.currentTurn = turn;
  const abort = () => session.handle.close("abort", context.abortSignal?.reason);
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  let startup: Promise<void> | undefined;
  try {
    // Consume startup records while initialization waits on the same stdout reader.
    startup = (async () => {
      context.abortSignal?.throwIfAborted();
      // Adopt the process's exact MCP capture before prompt dispatch or native tool callbacks.
      capability?.activate(session.handle);
      if (!session.transport) {
        const { args, excludeDynamicSections } = prepareClaudeCliTransportArgs(context);
        session.transport = createClaudeCliTransport({
          context,
          args,
          secretInput,
          currentContext: () => session.currentTurn?.context,
          initialize: {
            appendSystemPrompt: context.systemPrompt,
            // Native snapshots must not override the host's refreshed prompt on resume.
            systemPromptSnapshot: false,
            excludeDynamicSections,
            hooks: {
              UserPromptSubmit: [{ hookCallbackIds: ["UserPromptSubmit"] }],
              PreToolUse: [{ hookCallbackIds: ["PreToolUse"] }],
            },
          },
          onMessage: (message) => acceptMessage(session, message),
          onRequest: async (request, signal) => {
            // No interactive MCP elicitation handler is registered; preserve its declined outcome.
            if (request.subtype === "elicitation") {
              return () => ({ action: "decline" });
            }
            const admittedTurn = activeTurn(session);
            const response = await handleRequest(session, request, signal);
            // The transport invokes this synchronously at its final write, after all awaits.
            return () => {
              if (admittedTurn && activeTurn(session) === admittedTurn && !signal.aborted) {
                return response;
              }
              const message = "The OpenClaw run is no longer active.";
              if (request.subtype === "can_use_tool") {
                return { behavior: "deny", message, toolUseID: request.tool_use_id };
              }
              return request.callback_id === "PreToolUse"
                ? {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: message,
                    },
                  }
                : {};
            };
          },
          onError: (error) => session.handle.close("abort", error),
        });
        await session.transport.initialize();
      }
      context.assertCurrent?.();
      if (session.closed || session.currentTurn !== turn) {
        throw turn.error ?? new Error("Claude CLI closed before its prompt was accepted.");
      }
      await session.transport.send(createUserInput(context, context.prompt, turn.inputUuid));
      context.registerMessageInjection?.({
        isAvailable: () =>
          session.hasInputLifecycle &&
          turn.inputStarted &&
          turn.promptSubmitted &&
          activeTurn(session) === turn,
        queueMessage: (text, withCurrent) => injectInput(session, turn, text, withCurrent),
      });
    })().catch((error: unknown) => session.handle.close("abort", error));
    for await (const record of turn.events) {
      yield record;
    }
    await startup;
    if (turn.error) {
      throw turn.error;
    }
    if (!turn.sawTerminalResult) {
      throw new Error("Claude CLI exited without a terminal result.");
    }
  } catch (error) {
    session.handle.close("abort", error);
    throw error;
  } finally {
    turn.controller.abort();
    context.abortSignal?.removeEventListener("abort", abort);
    // Iterator.return() is cancellation too; a partially consumed turn cannot stay warm.
    if (session.currentTurn === turn) {
      session.handle.close("abort");
    }
    await startup;
    if (session.closed) {
      await session.handle.waitForExit();
    }
  }
}
