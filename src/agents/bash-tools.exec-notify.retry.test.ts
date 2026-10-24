import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  SessionEventOutcome,
  SessionEventTarget,
} from "../auto-reply/reply/session-event-contract.js";
import { acknowledgeNotifyOnExit, type ProcessSession } from "./bash-process-registry.js";
import { maybeNotifyOnExit } from "./bash-tools.exec-notify.js";

// DER-604: a long background exec finished ~25 minutes after its turn ended; the one
// completion wake hit a transient SESSION_DELIVERY_GENERATION_UNAVAILABLE and was dropped.
const outcomes = vi.hoisted(() => [] as SessionEventOutcome[]);
const enqueueSessionEventMock = vi.hoisted(() =>
  vi.fn(() => ({
    id: "exec-event",
    cancel: vi.fn(() => true),
    accepted: Promise.resolve({ ok: true as const }),
    settled: Promise.resolve(
      outcomes.shift() ?? {
        status: "completed" as const,
        executionStarted: true,
        delivered: false,
      },
    ),
  })),
);
// mock-isolation: Session admission is covered by session-event-handoff tests; this owns retry.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: vi.fn(),
  enqueueSessionEventForHost: enqueueSessionEventMock,
}));

const sessionKey = "agent:main:dashboard:late-exec-wake";
const target: SessionEventTarget = {
  agentId: "main",
  sessionKey,
  sessionId: "original-session",
  generation: "test",
};
const transient: SessionEventOutcome = {
  status: "failed",
  executionStarted: true,
  delivered: false,
  error: "Session event execution failed",
  retryable: true,
};

function finishedSession(): ProcessSession {
  return {
    id: "calm-daisy-0001",
    command: "long job",
    sessionKey,
    agentId: "main",
    cleanupMs: 0,
    notifyOnExit: true,
    notifySessionTarget: target,
    startedAt: 0,
    maxOutputChars: 1000,
    totalOutputChars: 1,
    pendingOutput: "",
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    pendingOutputDropped: false,
    aggregated: "0",
    tail: "0",
    exitCode: 1,
    exited: true,
    truncated: false,
    backgrounded: true,
    cursorKeyMode: "unknown",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  outcomes.length = 0;
  enqueueSessionEventMock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

test("retries a non-zero exit wake refused by a transient session-storage window", async () => {
  outcomes.push(transient);
  const session = finishedSession();
  maybeNotifyOnExit(session, "failed", false);
  expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(2_000);

  expect(enqueueSessionEventMock).toHaveBeenCalledTimes(2);
  const calls = enqueueSessionEventMock.mock.calls as unknown as Array<
    [string, { expectedTarget?: SessionEventTarget; source: string }]
  >;
  for (const [text, options] of calls) {
    expect(text).toBe("Exec failed (calm-dai, code 1) :: 0");
    // The retry keeps the captured destination; a reset session still refuses it.
    expect(options).toMatchObject({ source: "exec", expectedTarget: target });
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(enqueueSessionEventMock).toHaveBeenCalledTimes(2);
});

test("stops after a bounded number of retries", async () => {
  outcomes.push(transient, transient, transient, transient, transient);
  maybeNotifyOnExit(finishedSession(), "failed", false);

  await vi.advanceTimersByTimeAsync(120_000);

  expect(enqueueSessionEventMock).toHaveBeenCalledTimes(4);
});

test("does not retry a failure that is not retryable", async () => {
  outcomes.push({ ...transient, retryable: undefined });
  maybeNotifyOnExit(finishedSession(), "failed", false);

  await vi.advanceTimersByTimeAsync(120_000);

  expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
});

test("drops a pending retry once the process result is observed", async () => {
  outcomes.push(transient);
  const session = finishedSession();
  maybeNotifyOnExit(session, "failed", false);
  await vi.advanceTimersByTimeAsync(0);

  acknowledgeNotifyOnExit(session);
  await vi.advanceTimersByTimeAsync(120_000);

  expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
});

test("drops a pending retry after the requesting turn cancelled the process", async () => {
  outcomes.push(transient);
  const session = finishedSession();
  maybeNotifyOnExit(session, "failed", false);
  await vi.advanceTimersByTimeAsync(0);

  session.requestCancelled = true;
  await vi.advanceTimersByTimeAsync(120_000);

  expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
});

test("contains a retry that is refused at admission", async () => {
  outcomes.push(transient);
  maybeNotifyOnExit(finishedSession(), "failed", false);
  enqueueSessionEventMock.mockImplementationOnce(() => {
    throw new Error(
      "Session event destination was reset or replaced while its producer was running",
    );
  });

  await vi.advanceTimersByTimeAsync(120_000);

  expect(enqueueSessionEventMock).toHaveBeenCalledTimes(2);
});
