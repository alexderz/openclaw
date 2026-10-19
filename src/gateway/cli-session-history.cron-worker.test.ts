import { expect, it, vi } from "vitest";
import type { ChatHistoryPageParams } from "../config/sessions/session-history-types.js";
import type { WorkerTaskChannel } from "../infra/worker-task-server.js";
import { readProcessHeldCliHistoryInWorker } from "./cli-session-history.process-held.js";
import { readChatHistoryPageKernel } from "./server-methods/chat-history-page-kernel.js";
import type { SessionTranscriptPageReader } from "./session-transcript-read.types.js";

vi.mock("./cli-session-history.ts", () => ({
  prepareCliSessionHistoryReader: vi.fn(async () => undefined),
  readChatHistoryMessageFromReaders: vi.fn(),
}));
const cron = {
  role: "user",
  content: "[cron:job-cli Harness] Hello",
  provenance: {
    kind: "internal_system",
    sourceSessionKey: "agent:main:cron:job-cli:run:test",
    sourceTool: "cron",
    sourcePromptPrefix: "[cron:job-cli Harness]",
    jobId: "job-cli",
    runId: "test",
  },
  __openclaw: { id: "m-cron", seq: 1 },
};
const params = {
  sessionId: "session",
  storePath: "/tmp/backend-harness/sessions.json",
  sessionAgentId: "main",
  canonicalKey: "agent:main:main",
  entry: { sessionId: "session", updatedAt: 1 },
  max: 50,
  maxHistoryBytes: 1048576,
  effectiveMaxChars: 12000,
  provider: "claude-cli",
  offset: undefined,
  messageId: undefined,
} satisfies ChatHistoryPageParams;
function page(message: unknown) {
  return {
    messages: [message],
    rawMessages: [message],
    totalMessages: 1,
    displaySource: "harness",
    transcriptSource: "active",
    readWindow: { source: "harness", latestResetRawSeq: null },
    found: true,
    offset: 0,
    hasOverreadContext: false,
  };
}
function readers(message: unknown) {
  return {
    readRecentSessionMessagesWithStatsAsync: vi.fn(async () => page(message)),
  } as unknown as SessionTranscriptPageReader;
}
it("CLI worker projects forwarded cron with deferred labels", async () => {
  const result = await readChatHistoryPageKernel(params, {
    readers: readers(cron),
    readOnly: true,
    deferProfileDisplay: true,
    resolveCronJobName: () => undefined,
  });
  expect(result.messages.length).toBeGreaterThan(0);
});
it.each(["claude-cli", "openai"])(
  "held %s worker projects forwarded cron safely",
  async (provider) => {
    const channel = {
      request: async () => ({ input: page(cron), consumed() {} }),
    } as unknown as WorkerTaskChannel;
    // 10.5 wraps worker history in a typed display request/result.
    const result = await readProcessHeldCliHistoryInWorker(
      { kind: "rpc", params: { ...params, provider } },
      channel,
    );
    expect(result.kind).toBe("rpc");
    expect(result.kind === "rpc" ? result.page.messages.length : 0).toBeGreaterThan(0);
  },
);
it("normal history remains readable", async () => {
  const result = await readChatHistoryPageKernel(params, {
    readers: readers({
      role: "user",
      content: "Local question",
      __openclaw: { seq: 1, id: "normal" },
    }),
    readOnly: true,
    deferProfileDisplay: true,
  });
  expect(result.messages.length).toBeGreaterThan(0);
});
