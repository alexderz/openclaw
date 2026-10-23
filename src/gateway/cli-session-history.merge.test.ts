import { describe, expect, it } from "vitest";
import { buildCliSessionDriftNote } from "../agents/cli-session.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.test-support.js";

describe("imported Claude history merge", () => {
  it.each([
    ["alone", ""],
    ["after a drift note", `${buildCliSessionDriftNote(["prompt-tools"])}\n\n`],
  ])("shows a resumed turn carrying unseen exchanges once %s", (_label, driftNote) => {
    const timestamp = Date.parse("2026-09-10T10:57:09.764Z");
    const localMeta = { id: "local-review-ask" };
    const importedMeta = { importedFrom: "claude-cli", externalId: "carried", cliSessionId: "s-1" };
    const localMessage = {
      role: "user",
      content: "What did the review find?",
      timestamp,
      __openclaw: localMeta,
    };
    const carried = [
      "Recorded completion events: ⟦openclaw:ctx⟧",
      "```json",
      '[{"source":"subagent_announce","reply":"The review found one issue."}]',
      "```",
    ].join("\n");
    const importedMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `${driftNote}${carried}\n\n[Thu 2026-03-26 16:29 GMT] What did the review find?`,
        },
      ],
      timestamp: timestamp + 1_531,
      __openclaw: importedMeta,
    };

    expect(
      mergeImportedChatHistoryMessages({
        localMessages: [localMessage],
        importedMessages: [importedMessage],
      }),
    ).toEqual([{ ...localMessage, __openclaw: { ...localMeta, ...importedMeta } }]);
  });

  it("keeps a queued input after the reply it waited behind", () => {
    const start = Date.parse("2026-10-23T22:59:04.907Z");
    const meta = (externalId: string) => ({
      importedFrom: "claude-cli",
      externalId,
      cliSessionId: "s-1",
    });
    const first = { role: "user", content: "What's going", timestamp: start };
    const firstReply = {
      role: "assistant",
      content: [{ type: "text", text: "Here's where it stands." }],
      timestamp: start + 107_000,
    };
    // Accepted 1.5 s after the first send, recorded when it ran after the reply.
    const queued = {
      role: "user",
      content: "What's going on",
      timestamp: start + 1_500,
      __openclaw: { id: "local-queued", recordTimestampMs: start + 107_500 },
    };
    const queuedReply = {
      role: "assistant",
      content: [{ type: "text", text: "Your message came through twice." }],
      timestamp: start + 120_000,
    };
    // A native-only tool call expands the index into timestamp order.
    const toolCall = {
      role: "assistant",
      content: [{ type: "toolcall", id: "toolu_1", name: "Bash", arguments: { command: "ls" } }],
      timestamp: start + 50_000,
      __openclaw: meta("a-tool"),
    };

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [first, firstReply, queued, queuedReply],
      importedMessages: [
        { ...first, __openclaw: meta("u-first") },
        toolCall,
        { ...firstReply, __openclaw: meta("a-first") },
        {
          role: "user",
          content: queued.content,
          timestamp: start + 108_000,
          __openclaw: meta("u-queued"),
        },
        { ...queuedReply, __openclaw: meta("a-queued") },
      ],
    }) as { content: unknown }[];

    expect(merged.map((message) => message.content)).toEqual([
      first.content,
      toolCall.content,
      firstReply.content,
      queued.content,
      queuedReply.content,
    ]);
  });

  describe("a run with several native end_turn segments", () => {
    const start = Date.parse("2026-10-22T10:00:00.000Z");
    const meta = (externalId: string) => ({
      importedFrom: "claude-cli",
      externalId,
      cliSessionId: "s-1",
    });
    const nativeText = (externalId: string, text: string, timestamp: number) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "claude-cli",
      stopReason: "end_turn",
      timestamp,
      __openclaw: meta(externalId),
    });
    const prompt = { role: "user", content: "Set up the backups", timestamp: start };
    const first = "I've started setting up the backups.";
    const second = "Backups are running, and the first run finished.";
    const notificationAt = start + 46 * 60_000;
    const importedPrompt = { ...prompt, timestamp: start + 400, __openclaw: meta("u-prompt") };
    const segmentA = nativeText("a-first", first, start + 60_000);
    const notification = {
      role: "user",
      content:
        "<task-notification>\n<task-id>t-1</task-id>\n<status>completed</status>\n</task-notification>",
      provenance: { kind: "internal_system", sourceTool: "claude_cli_task_notification" },
      timestamp: notificationAt,
      __openclaw: meta("u-notification"),
    };
    const narration = nativeText(
      "a-narration",
      "Checking the first run now.",
      notificationAt + 5_000,
    );
    const toolCall = {
      role: "assistant",
      content: [{ type: "toolcall", id: "toolu_1", name: "Bash", arguments: { command: "ls" } }],
      timestamp: notificationAt + 10_000,
      __openclaw: meta("a-tool"),
    };
    const segmentB = nativeText("a-second", second, notificationAt + 30_000);
    const composite = (text: string) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "cli",
      provider: "claude-cli",
      idempotencyKey: "cli-assistant:run-1",
      timestamp: notificationAt + 30_300,
      __openclaw: { id: "local-final" },
    });

    it("shows each segment once at its native position", () => {
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [prompt, composite(`${first}\n${second}`)],
        importedMessages: [importedPrompt, segmentA, notification, narration, toolCall, segmentB],
      });

      expect(merged).toEqual([
        { ...prompt, __openclaw: meta("u-prompt") },
        segmentA,
        notification,
        narration,
        toolCall,
        segmentB,
      ]);
    });

    it("keeps a local reply whose text the native segments do not fully cover", () => {
      const local = composite(`${first}\n${second}\nA closing line only OpenClaw saw.`);
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [prompt, local],
        importedMessages: [importedPrompt, segmentA, notification, segmentB],
      });

      expect(merged).toContainEqual(local);
      expect(merged).toHaveLength(5);
    });

    it("does not claim a segment from an earlier operator turn", () => {
      const nextPrompt = { role: "user", content: "And now?", timestamp: notificationAt + 20_000 };
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [prompt, nextPrompt, composite(`${first}\n${second}`)],
        importedMessages: [
          importedPrompt,
          segmentA,
          { ...nextPrompt, timestamp: nextPrompt.timestamp + 300, __openclaw: meta("u-next") },
          segmentB,
        ],
      });

      expect(merged).toContainEqual(composite(`${first}\n${second}`));
    });

    it.each([
      [
        "a persisted media fact",
        {
          ...composite(`${first}\n${second}`),
          __openclaw: { id: "local-final", media: [{ kind: "image", path: "/tmp/chart.png" }] },
        },
      ],
      [
        "a non-text block",
        {
          ...composite(""),
          content: [
            { type: "text", text: `${first}\n${second}` },
            { type: "image", data: "aGk=", mimeType: "image/png" },
          ],
        },
      ],
    ])("keeps a joined local reply carrying %s", (_label, local) => {
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [prompt, local],
        importedMessages: [importedPrompt, segmentA, notification, segmentB],
      });

      expect(merged).toContainEqual(local);
    });

    it("keeps a joined local reply carrying a MEDIA: directive", () => {
      const withMedia = `${second}\nMEDIA:./chart.png`;
      const local = composite(`${first}\n${withMedia}`);
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [prompt, local],
        importedMessages: [
          importedPrompt,
          segmentA,
          notification,
          nativeText("a-media", withMedia, notificationAt + 30_000),
        ],
      });

      expect(merged).toContainEqual(local);
    });

    it("walks past an uncoalesced tool-result carrier between segments", () => {
      const toolResult = {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_other", content: "ok" }],
        timestamp: notificationAt + 20_000,
        __openclaw: meta("u-tool-result"),
      };
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [prompt, composite(`${first}\n${second}`)],
        importedMessages: [importedPrompt, segmentA, notification, toolResult, segmentB],
      });

      expect(merged).not.toContainEqual(composite(`${first}\n${second}`));
    });

    it("does not claim a segment across an image-only operator prompt", () => {
      const imagePrompt = {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
        ],
        timestamp: notificationAt,
        __openclaw: meta("u-image"),
      };
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [prompt, composite(`${first}\n${second}`)],
        importedMessages: [importedPrompt, segmentA, imagePrompt, segmentB],
      });

      expect(merged).toContainEqual(composite(`${first}\n${second}`));
    });

    it.each([
      ["line breaks and directive tags", `[[reply_to_current]] ${first}\n\n  ${second}\n`, false],
      ["a missing separator", `${first}${second}`, true],
    ])("treats a join differing by %s as documented", (_label, text, kept) => {
      const local = composite(text);
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [prompt, local],
        importedMessages: [importedPrompt, segmentA, notification, segmentB],
      });

      expect(merged.slice(1, 4)).toEqual([segmentA, notification, segmentB]);
      expect(merged.slice(4)).toEqual(kept ? [local] : []);
    });

    it("does not reuse segments already claimed by an earlier joined row", () => {
      const firstJoin = composite(`${first}\n${second}`);
      const secondJoin = {
        ...firstJoin,
        idempotencyKey: "cli-assistant:run-2",
        timestamp: firstJoin.timestamp + 1_000,
        __openclaw: { id: "local-final-2" },
      };
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [prompt, firstJoin, secondJoin],
        importedMessages: [importedPrompt, segmentA, notification, segmentB],
      });

      expect(merged).not.toContainEqual(firstJoin);
      expect(merged).toContainEqual(secondJoin);
    });
  });
});
