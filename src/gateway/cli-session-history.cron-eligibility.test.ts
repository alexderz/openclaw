import { expect, it, vi } from "vitest";
import type { ChatHistoryPageParams } from "../config/sessions/session-history-types.js";
import { prepareCliSessionHistoryReader, type CliHistoryReaders } from "./cli-session-history.js";
const message = {
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
it("non-Claude eligibility projects cron before declining native import", async () => {
  const read = vi.fn(async () => ({
    messages: [message],
    rawMessages: [message],
    totalMessages: 1,
    displaySource: "harness",
    transcriptSource: "active",
    readWindow: { source: "harness", latestResetRawSeq: null },
    found: true,
    offset: 0,
    hasOverreadContext: false,
  }));
  const params = {
    sessionId: "session",
    storePath: "/tmp/harness/sessions.json",
    sessionAgentId: "main",
    canonicalKey: "agent:main:main",
    entry: { sessionId: "session", updatedAt: 1, cliSessionIds: { "claude-cli": "native" } },
    max: 50,
    maxHistoryBytes: 1048576,
    effectiveMaxChars: 12000,
    provider: "openai",
    offset: undefined,
    messageId: undefined,
  } satisfies ChatHistoryPageParams;
  const result = await prepareCliSessionHistoryReader(params, {
    readRecentSessionMessagesWithStatsAsync: read,
  } as unknown as CliHistoryReaders);
  expect(result).toBeUndefined();
  expect(read).toHaveBeenCalledOnce();
});
