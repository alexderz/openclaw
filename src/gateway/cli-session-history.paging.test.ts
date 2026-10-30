import rawFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { captureTranscriptRedactionSnapshot } from "../agents/transcript-redact-text.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../state/openclaw-agent-db-readonly-scope.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCliSessionHistoryReader } from "./cli-session-history.js";
import { withClaudeProjectsDir } from "./cli-session-history.test-support.js";
import { readChatHistoryPageKernel } from "./server-methods/chat-history-page-kernel.js";
import { prepareChatHistoryResponsePage } from "./server-methods/chat-history-response-page.js";
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import { archiveSessionTranscriptPaths } from "./session-transcript-files.fs.js";

it("serves a captured history prefix while both transcripts append and observes the next revision", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId: nativeId, filePath }) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cli-prefix",
        sessionId: "cli-prefix",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: nativeId } },
      };
      await replaceSessionEntry(scope, entry);
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        ...Array.from({ length: 70 }, (_, index) => ({
          type: "message",
          id: `local-${index + 1}`,
          parentId: index ? `local-${index}` : null,
          message: { role: "assistant", content: `Local ${index + 1}`, timestamp: index + 1 },
        })),
      ]);
      await waitForSessionTranscriptProjection(scope);
      const native = (id: string, timestamp: number) =>
        JSON.stringify({
          type: "assistant",
          uuid: id,
          timestamp: new Date(timestamp).toISOString(),
          message: { role: "assistant", content: id },
        });
      await fs.writeFile(filePath, native("external-prefix", 0));
      const nativePath = await fs.realpath(filePath);
      const createReadStream = rawFs.createReadStream;
      let nativeAppended = false;
      const stream = vi.spyOn(rawFs, "createReadStream").mockImplementation((file, options) => {
        if (file === nativePath && !nativeAppended) {
          nativeAppended = true;
          rawFs.appendFileSync(filePath, `\n${native("external-appended", 1000)}`);
        }
        return createReadStream(file, options);
      });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const target = {
        transcript: { ...scope, sessionFile: scope.sessionKey },
        database: { agentId: database.agentId, path: database.path },
        entryValidationKey: scope.sessionKey,
      };
      const owner = new OpenClawAgentDatabaseReadOnlyScope();
      const base = createReadonlySessionHistoryReader(target);
      let localAppended = false;
      const readers = {
        ...base,
        async readSessionMessagesPageWithStatsAsync(
          ...args: Parameters<typeof base.readSessionMessagesPageWithStatsAsync>
        ) {
          const page = await base.readSessionMessagesPageWithStatsAsync(...args);
          if (!localAppended && args[1].captureReadWindow) {
            localAppended = true;
            await appendTranscriptMessage(scope, {
              eventId: "local-appended",
              message: { role: "assistant", content: "Local appended", timestamp: 1001 },
            });
          }
          return page;
        },
      };
      const params = {
        entry,
        provider: "claude-cli",
        sessionId: scope.sessionId,
        storePath: scope.storePath,
        sessionAgentId: scope.agentId,
        canonicalKey: scope.sessionKey,
        cliHistoryHomeDir: homeDir,
        cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
        max: 4,
        maxHistoryBytes: 64 * 1024,
        effectiveMaxChars: 4096,
        offset: undefined,
        messageId: undefined,
      };
      const read = () =>
        owner.run(target.database, async () => {
          const cli = await prepareCliSessionHistoryReader(params, readers);
          if (!cli) {
            throw new Error("Expected native history reader");
          }
          try {
            return await readChatHistoryPageKernel(params, {
              readers: cli.readers,
              readMessageSequence: cli.sequence,
              deferProfileDisplay: true,
            });
          } finally {
            cli.dispose();
          }
        });
      try {
        const first = await read();
        expect(first.messages.map(readChatHistoryMessageId)).toEqual([
          "local-67",
          "local-68",
          "local-69",
          "local-70",
        ]);
        expect(first.activeLeafEntryId).toBe("local-70");
        const next = await read();
        expect(next.messages.map(readChatHistoryMessageId)).toEqual([
          "local-69",
          "local-70",
          "external-appended",
          "local-appended",
        ]);
        expect(next.activeLeafEntryId).toBe("local-appended");
      } finally {
        stream.mockRestore();
        owner.close();
      }
    });
  });
});

it("applies native history eligibility to actual empty, message, and marker-only source pages", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId: nativeId }) => {
      const scope = {
        agentId: "main",
        sessionId: "cli-eligibility",
        sessionKey: "agent:main:cli-eligibility",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: nativeId } },
      };
      await replaceSessionEntry(scope, entry);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const target = {
        transcript: { ...scope, sessionFile: scope.sessionKey },
        database: { agentId: database.agentId, path: database.path },
        entryValidationKey: scope.sessionKey,
      };
      const owner = new OpenClawAgentDatabaseReadOnlyScope();
      const readers = createReadonlySessionHistoryReader(target);
      const message = {
        type: "message",
        id: "local",
        parentId: null,
        message: { role: "assistant", content: "Local answer" },
      };
      const marker = {
        type: "compaction",
        id: "compact",
        parentId: null,
        summary: "Compacted",
        tokensBefore: 100,
        firstKeptEntryId: null,
      };
      const cronInput = {
        ...message,
        message: {
          role: "user",
          content: "[cron:job-cli native CLI override] Run the bounded task.",
          provenance: {
            kind: "internal_system",
            sourceSessionKey: "agent:main:cron:job-cli:run:cli-eligibility",
            sourceTool: "cron",
            sourcePromptPrefix: "[cron:job-cli native CLI override]",
            jobId: "job-cli",
            runId: "cli-eligibility",
          },
        },
      };
      try {
        for (const cell of [
          { provider: "claude-cli", events: [message], imported: true },
          { provider: "anthropic", events: [message], imported: true },
          { provider: "openai", events: [message], imported: false },
          { provider: "openai", events: [cronInput], imported: false },
          { provider: "openai", events: [marker], imported: false },
          { provider: "openai", events: [], imported: true },
        ]) {
          await replaceTranscriptEvents(scope, [
            { type: "session", version: 3, id: scope.sessionId },
            ...cell.events,
          ]);
          await waitForSessionTranscriptProjection(scope);
          await owner.run(target.database, async () => {
            const cli = await prepareCliSessionHistoryReader(
              {
                entry,
                provider: cell.provider,
                sessionId: scope.sessionId,
                storePath: scope.storePath,
                sessionAgentId: scope.agentId,
                canonicalKey: scope.sessionKey,
                cliHistoryHomeDir: homeDir,
                cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
                max: 10,
                maxHistoryBytes: 64 * 1024,
                effectiveMaxChars: 4096,
                offset: undefined,
                messageId: undefined,
              },
              readers,
            );
            try {
              expect(
                Boolean(cli),
                `${cell.provider} with ${cell.events[0]?.type ?? "empty"} history`,
              ).toBe(cell.imported);
              if (cli) {
                const page = await cli.readers.readRecentSessionMessagesWithStatsAsync(scope, {
                  maxMessages: 10,
                });
                expect(page.messages).toContainEqual(
                  expect.objectContaining({
                    __openclaw: expect.objectContaining({ cliSessionId: nativeId }),
                  }),
                );
              }
            } finally {
              cli?.dispose();
            }
          });
        }
      } finally {
        owner.close();
      }
    });
  });
});

it("observes newly available reset archives and refuses changed archive bodies under older identities", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId: nativeId, filePath }) => {
      const scope = {
        agentId: "main",
        sessionId: "cli-archive",
        sessionKey: "agent:main:cli-archive",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: nativeId } },
      };
      const header = { type: "session", version: 3, id: scope.sessionId };
      await replaceSessionEntry(scope, entry);
      await replaceTranscriptEvents(scope, [header]);
      await waitForSessionTranscriptProjection(scope);
      await fs.writeFile(
        filePath,
        JSON.stringify({
          type: "assistant",
          uuid: "native-only",
          timestamp: new Date(1).toISOString(),
          message: { role: "assistant", content: "Native body" },
        }),
      );
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const target = {
        transcript: { ...scope, sessionFile: scope.sessionKey },
        database: { agentId: database.agentId, path: database.path },
        entryValidationKey: scope.sessionKey,
      };
      const owner = new OpenClawAgentDatabaseReadOnlyScope();
      const readers = createReadonlySessionHistoryReader(target);
      const params = {
        entry,
        provider: "claude-cli",
        sessionId: scope.sessionId,
        storePath: scope.storePath,
        sessionAgentId: scope.agentId,
        canonicalKey: scope.sessionKey,
        cliHistoryHomeDir: homeDir,
        cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
        max: 10,
        maxHistoryBytes: 64 * 1024,
        effectiveMaxChars: 4096,
        offset: undefined,
        messageId: undefined,
      };
      const read = async () => {
        const cli = await prepareCliSessionHistoryReader(params, readers);
        if (!cli) {
          throw new Error("Expected native history reader");
        }
        try {
          return await readChatHistoryPageKernel(params, {
            readers: cli.readers,
            readMessageSequence: cli.sequence,
            deferProfileDisplay: true,
          });
        } finally {
          cli.dispose();
        }
      };
      const archive = (id: string, content: string) =>
        [
          header,
          {
            type: "message",
            id,
            parentId: null,
            message: { role: "assistant", content, timestamp: 0 },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n";
      try {
        await owner.run(target.database, async () => {
          const revision = readers.readHistoryRevision();
          expect((await read()).messages.map(readChatHistoryMessageId)).toEqual(["native-only"]);
          const legacyPath = path.join(state.sessionsDir(), `${scope.sessionId}.jsonl`);
          await fs.mkdir(path.dirname(legacyPath), { recursive: true });
          await fs.writeFile(legacyPath, archive("retained", "Retained body"));
          const archived = archiveSessionTranscriptPaths({
            paths: [legacyPath],
            reason: "reset",
          })[0];
          if (!archived) {
            throw new Error("Expected reset archive fixture");
          }
          expect(readers.readHistoryRevision()).toMatchObject({
            generation: revision.generation,
            indexedSeq: revision.indexedSeq,
          });
          expect((await read()).messages.map(readChatHistoryMessageId)).toEqual([
            "retained",
            "native-only",
          ]);

          const cli = await prepareCliSessionHistoryReader(params, readers);
          if (!cli) {
            throw new Error("Expected archive-backed native history reader");
          }
          try {
            const replacement = `${archived.archivedPath}.replacement`;
            await fs.writeFile(replacement, archive("replacement", "Replacement body"));
            await fs.rename(replacement, archived.archivedPath);
            await expect(
              readChatHistoryPageKernel(params, {
                readers: cli.readers,
                readMessageSequence: cli.sequence,
                deferProfileDisplay: true,
              }),
            ).rejects.toMatchObject({
              name: "SessionTranscriptProjectionUnavailableError",
              reason: "window-changed",
            });
          } finally {
            cli.dispose();
          }
          const refreshed = await read();
          expect(refreshed.messages.map(readChatHistoryMessageId)).toEqual([
            "replacement",
            "native-only",
          ]);
          expect(refreshed.messages).toContainEqual(
            expect.objectContaining({
              content: "Replacement body",
              __openclaw: expect.objectContaining({ id: "replacement" }),
            }),
          );
        });
      } finally {
        owner.close();
      }
    });
  });
});

it("resolves a retired display anchor only within its unchanged admitted sources", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId: nativeId, filePath }) => {
      const scope = {
        agentId: "main", sessionKey: "agent:main:composite-alias", sessionId: "composite-alias",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const entry = { sessionId: scope.sessionId, updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: nativeId } } };
      await replaceSessionEntry(scope, entry);
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        { type: "message", id: "local-prompt", parentId: null,
          message: { role: "user", content: "prompt", timestamp: 1000,
            provenance: { kind: "inter_session", sourceTool: "subagent_announce" } } },
        { type: "message", id: "local-composite", parentId: "local-prompt",
          message: { role: "assistant", provider: "claude-cli", api: "cli", content: "a b", timestamp: 1250 } },
        ...Array.from({ length: 64 }, (_, i) => ({
          type: "message", id: `ordinary-local-${i}`, parentId: i === 0 ? "local-composite" : `ordinary-local-${i - 1}`,
          message: { role: "assistant", content: `ordinary ${i}`, timestamp: 1300 + i },
        })),
      ]);
      await waitForSessionTranscriptProjection(scope);
      const native = (role: string, uuid: string, content: string, timestamp: number) => JSON.stringify({
        type: role, uuid, timestamp: new Date(timestamp).toISOString(),
        message: { role, content },
      });
      await fs.writeFile(filePath, [native("user", "native-prompt", "prompt", 1000),
        native("assistant", "native-a", "a", 1100), native("assistant", "native-b", "b", 1200)].join("\n") + "\n");
      await fs.mkdir(state.sessionsDir(), { recursive: true });
      await fs.writeFile(path.join(state.sessionsDir(), `${scope.sessionId}.jsonl.reset.2026-09-30T00-00-00.000Z`), [
        { type: "session", version: 3, id: scope.sessionId },
        { type: "message", id: "archive-only", parentId: null,
          message: { role: "assistant", content: "archived canonical", timestamp: 900 } },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n");
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const target = { transcript: { ...scope, sessionFile: scope.sessionKey },
        database: { agentId: database.agentId, path: database.path }, entryValidationKey: scope.sessionKey };
      const owner = new OpenClawAgentDatabaseReadOnlyScope();
      const base = createReadonlySessionHistoryReader(target);
      let mutateDuringLookup = false;
      const readers = {
        ...base,
        async readSessionMessageByIdAsync(...args: Parameters<typeof base.readSessionMessageByIdAsync>) {
          const result = await base.readSessionMessageByIdAsync(...args);
          if (mutateDuringLookup) {
            mutateDuringLookup = false;
            await fs.appendFile(filePath, native("assistant", "replacement", "new", 1300) + "\n");
          }
          return result;
        },
      };
      const params = { entry, provider: "claude-cli", sessionId: scope.sessionId,
        storePath: scope.storePath, sessionAgentId: scope.agentId, canonicalKey: scope.sessionKey,
        cliHistoryHomeDir: homeDir, cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
        max: 4, maxHistoryBytes: 64 * 1024, effectiveMaxChars: 4096, offset: undefined,
        messageId: "local-composite" };
      try {
        await owner.run(target.database, async () => {
          let oldSource: string | undefined;
          const cli = await prepareCliSessionHistoryReader(params, readers);
          if (!cli) { throw new Error("Expected native history reader"); }
          try {
            const archiveParams = { ...params, messageId: "archive-only" };
            const archiveReader = await prepareCliSessionHistoryReader(archiveParams, readers);
            if (!archiveReader) { throw new Error("Expected reader for archive anchor"); }
            try {
              const archivePage = await readChatHistoryPageKernel(archiveParams, { readers: archiveReader.readers,
                readMessageSequence: archiveReader.sequence, deferProfileDisplay: true });
              expect(archivePage.messages.map(readChatHistoryMessageId)).toContain("archive-only");
              expect(archivePage.anchor?.resolvedMessageId).toBeUndefined();
            } finally { archiveReader.dispose(); }
            const pagedIds: string[] = [];
            for (let offset = 0; offset < 67; offset++) {
              const part = await cli.readers.readSessionMessagesPageWithStatsAsync(scope, {
                offset, maxMessages: 1, maxBytes: 512,
              });
              expect(part.totalMessages).toBe(67);
              expect(part.messages).toHaveLength(1);
              pagedIds.unshift(readChatHistoryMessageId(part.messages[0])!);
            }
            expect(pagedIds).toEqual(["local-prompt", "native-a", "native-b",
              ...Array.from({ length: 64 }, (_, i) => `ordinary-local-${i}`)]);
            expect(await cli.readers.readSessionMessageByIdAsync(scope, "unknown")).toMatchObject({ found: false });
            const canonical = await cli.readers.readSessionMessageByIdAsync(scope, "local-composite");
            expect(canonical).toMatchObject({ found: true, message: { content: "a b" } });
            const hidden = await cli.readers.readSessionMessageByIdAsync(scope, "local-composite", {
              historyVisibility: { sessionStartedAt: 2000 },
            });
            expect(hidden).toMatchObject({ found: false, historyHidden: true });
            const page = await readChatHistoryPageKernel(params, { readers: cli.readers,
              readMessageSequence: cli.sequence, deferProfileDisplay: true });
            expect(page.anchor?.resolvedMessageId).toBe("native-b");
            oldSource = page.anchor?.source;
            expect(page.messages.map(readChatHistoryMessageId)).toContain("native-b");
            expect(page.messages.map(readChatHistoryMessageId)).not.toContain("local-composite");
            expect(prepareChatHistoryResponsePage(page, params).messages.map(readChatHistoryMessageId)).toContain("native-b");
            expect(cli.sequence(canonical.message)).toBe(cli.sequence(page.messages.find(
              (message) => readChatHistoryMessageId(message) === "native-b")));
            for (const foreignScope of [
              { ...scope, sessionId: "foreign" },
              { ...scope, agentId: "foreign" },
              { ...scope, storePath: path.join(state.sessionsDir(), "foreign.json") },
              { ...scope, sessionKey: "agent:main:foreign" },
            ]) {
              await expect(cli.readers.readSessionMessagesAroundIdWithStatsAsync(
                foreignScope, { messageId: "local-composite", maxMessages: 4 },
              )).rejects.toMatchObject({ name: "SessionTranscriptProjectionUnavailableError" });
            }
            mutateDuringLookup = true;
            await expect(readChatHistoryPageKernel(params, { readers: cli.readers,
              readMessageSequence: cli.sequence, deferProfileDisplay: true }))
              .rejects.toMatchObject({ name: "SessionTranscriptProjectionUnavailableError", reason: "window-changed" });
          } finally { cli.dispose(); }
          const refreshed = await prepareCliSessionHistoryReader(params, readers);
          if (!refreshed || !oldSource) { throw new Error("Expected rebuilt index and old cursor source"); }
          try {
            const freshPage = await readChatHistoryPageKernel(params, { readers: refreshed.readers,
              readMessageSequence: refreshed.sequence, deferProfileDisplay: true });
            expect(freshPage.anchor?.resolvedMessageId).toBe("native-b");
            const staleCursorParams = { ...params, pageCursor: { sessionId: scope.sessionId,
              source: oldSource, messageId: "local-composite", direction: "older" as const } };
            const staleReader = await prepareCliSessionHistoryReader(staleCursorParams, readers);
            if (!staleReader) { throw new Error("Expected cursor reader"); }
            try {
              const stalePage = await readChatHistoryPageKernel(staleCursorParams, { readers: staleReader.readers,
                readMessageSequence: staleReader.sequence, deferProfileDisplay: true });
              expect(stalePage.windowReset).toBe(true);
            } finally { staleReader.dispose(); }
            // Exercise a real second SQLite connection, not a fabricated revision object.
            const priorRevision = readers.readHistoryRevision();
            const replacementOwner = new OpenClawAgentDatabaseReadOnlyScope();
            try {
              await replacementOwner.run(target.database, async () => {
                const replacementRevision = readers.readHistoryRevision();
                expect(replacementRevision.database).not.toBe(priorRevision.database);
                expect(replacementRevision.generation).toBe(priorRevision.generation);
                await expect(readChatHistoryPageKernel(params, { readers: refreshed.readers,
                  readMessageSequence: refreshed.sequence, deferProfileDisplay: true }))
                  .rejects.toMatchObject({ name: "SessionTranscriptProjectionUnavailableError", reason: "window-changed" });
                const replacement = await prepareCliSessionHistoryReader(params, readers);
                if (!replacement) { throw new Error("Expected reader on replacement database object"); }
                try {
                  const page = await readChatHistoryPageKernel(params, { readers: replacement.readers,
                    readMessageSequence: replacement.sequence, deferProfileDisplay: true });
                  expect(page.anchor?.resolvedMessageId).toBe("native-b");
                } finally { replacement.dispose(); }
              });
            } finally { replacementOwner.close(); }
            const generationReader = await prepareCliSessionHistoryReader(params, readers);
            if (!generationReader) { throw new Error("Expected reader before generation replacement"); }
            await replaceTranscriptEvents(scope, [
              { type: "session", version: 3, id: scope.sessionId },
              { type: "message", id: "local-composite", parentId: null,
                message: { role: "assistant", content: "replacement using same id", timestamp: 1400 } },
            ]);
            await waitForSessionTranscriptProjection(scope);
            try {
              await expect(readChatHistoryPageKernel(params, { readers: generationReader.readers,
                readMessageSequence: generationReader.sequence, deferProfileDisplay: true }))
                .rejects.toMatchObject({ name: "SessionTranscriptProjectionUnavailableError", reason: "window-changed" });
            } finally { generationReader.dispose(); }
          } finally { refreshed.dispose(); }
          const foreignId = "df6472b9-72b9-4894-bac8-279d8058e52f";
          await fs.writeFile(path.join(path.dirname(filePath), `${foreignId}.jsonl`),
            native("assistant", "foreign-message", "foreign native", 1500) + "\n");
          const foreignBinding = { ...params, entry: { ...entry,
            cliSessionBindings: { "claude-cli": { sessionId: foreignId } } } };
          const foreignReader = await prepareCliSessionHistoryReader(foreignBinding, readers);
          if (!foreignReader) { throw new Error("Expected actual foreign binding reader"); }
          try {
            const foreignPage = await readChatHistoryPageKernel(foreignBinding, { readers: foreignReader.readers,
              readMessageSequence: foreignReader.sequence, deferProfileDisplay: true });
            expect(foreignPage.anchor?.resolvedMessageId).toBeUndefined();
            expect(foreignPage.messages.map(readChatHistoryMessageId)).toContain("local-composite");
            expect(await foreignReader.readers.readSessionMessageByIdAsync(scope, "local-composite"))
              .toMatchObject({ found: true, message: { content: "replacement using same id" } });
          } finally { foreignReader.dispose(); }
        });
      } finally { owner.close(); }
    });
  });
});
