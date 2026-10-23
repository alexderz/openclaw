import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

beforeEach(() => {
  setActivePluginRegistry(createSessionConversationTestRegistry());
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

it("does not re-attach operator-created or promoted roots to the requester of a settled run", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const now = 1_790_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const home = "agent:main:main";
    const parent = "agent:main:dashboard:parent";
    const molting = "agent:main:dashboard:molting";
    const promoted = "agent:main:dashboard:promoted";
    const marked = "agent:main:dashboard:marked";
    const child = "agent:main:dashboard:child";
    const entries: Array<[string, SessionEntry]> = [
      [home, { sessionId: "home", updatedAt: now }],
      [parent, { sessionId: "parent", updatedAt: now, spawnDepth: 0, parentSessionKey: home }],
      // Molting shape: created by an operator, linked to Home, with an initial-task run row.
      [
        molting,
        {
          sessionId: "molting",
          updatedAt: now,
          createdVia: "operator",
          spawnDepth: 0,
          parentSessionKey: home,
          parentSessionId: "home",
        },
      ],
      // A detached promotion whose spawner run was not yet marked (a crash before the release).
      [
        promoted,
        {
          sessionId: "promoted",
          updatedAt: now,
          createdVia: "spawn",
          spawnDepth: 0,
          parentSessionKey: home,
          promotedFrom: {
            version: 1,
            requestId: "r",
            profileId: "human",
            at: 1,
            parentSessionKey: parent,
          },
        },
      ],
      // A legacy delegated row whose spawner run is already marked handed off.
      [marked, { sessionId: "marked", updatedAt: now, createdVia: "spawn" }],
      [
        child,
        {
          sessionId: "child",
          updatedAt: now,
          createdVia: "spawn",
          spawnedBy: parent,
          spawnDepth: 1,
          parentSessionKey: parent,
        },
      ],
    ];
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (const [sessionKey, entry] of entries) {
          writeSessionEntry(database, sessionKey, entry, {
            canonicalPreviousEntry: null,
            previousEntry: null,
          });
        }
      },
      { agentId: "main" },
    );
    const settled = (
      runId: string,
      childSessionKey: string,
      requesterSessionKey: string,
      extra: Partial<SubagentRunRecord> = {},
    ): SubagentRunRecord => ({
      runId,
      childSessionKey,
      requesterSessionKey,
      controllerSessionKey: requesterSessionKey,
      requesterDisplayKey: "synthetic",
      task: "synthetic",
      cleanup: "keep",
      createdAt: now - 2_000,
      execution: { status: "terminal", startedAt: now - 1_500, endedAt: now - 1_000 },
      completion: { required: false },
      delivery: { status: "not_required" },
      cleanupCompletedAt: now - 900,
      ...extra,
    });
    saveSubagentRegistryToSqlite(
      new Map(
        [
          settled("molting-initial", molting, home),
          settled("promoted-spawn", promoted, parent),
          settled("marked-spawn", marked, parent, {
            childHandoff: { kind: "session-promoted", at: now - 500 },
          }),
          settled("child-spawn", child, parent),
        ].map((row) => [row.runId, row]),
      ),
    );
    const release = retainSessionListForegroundWork();
    try {
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const rows = new Map(
        (await listProjectedSessions({ projection, opts: { archived: "all" } })).sessions.map(
          (row) => [row.key, row],
        ),
      );
      expect(rows.get(child)?.spawnedBy).toBe(parent);
      expect(rows.get(molting)?.spawnedBy).toBeUndefined();
      expect(rows.get(promoted)?.spawnedBy).toBeUndefined();
      expect(rows.get(marked)?.spawnedBy).toBeUndefined();
      const children = await listProjectedSessions({
        projection,
        opts: { spawnedBy: parent, archived: "all" },
      });
      expect(children.sessions.map((row) => row.key)).toEqual([child]);
      expect(rows.get(parent)?.childSessions ?? []).not.toContain(promoted);
    } finally {
      release();
      clock.mockRestore();
    }
  });
});
