import { expect, it } from "vitest";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { publishSessionEntryWorkerInvalidations } from "./session-accessor.sqlite-entry-worker-publication.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";

// DER-594: a worker commit whose metadata receipt cannot be installed (for example a
// SessionManager end-of-turn commit superseded by a concurrent row write) settles as an
// unknown publication. A queued follow-up that already holds a generation lease must
// re-validate the committed row instead of failing every later check as unavailable.
async function withUnknownPublication(
  run: (params: {
    generation: Awaited<ReturnType<typeof prepareSessionGenerationFacts>>;
    scope: { agentId: string; storePath: string; sessionKey: string };
    original: { sessionId: string; lifecycleRevision: string; updatedAt: number };
  }) => void | Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:dashboard:unknown-publication",
    };
    const original = {
      sessionId: "e1234567-1234-1234-1234-123456789abc",
      lifecycleRevision: "original-lifecycle",
      updatedAt: 1,
    };
    replaceSessionEntrySync(scope, original);
    const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
    try {
      generation.assertCurrent();
      const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
      if (typeof identity !== "string") {
        throw new Error("Expected a file-backed agent database identity");
      }
      publishSessionEntryWorkerInvalidations(
        { agentId: scope.agentId, storePath: scope.storePath, databaseIdentity: identity },
        [scope.sessionKey],
      );
      await run({ generation, scope, original });
    } finally {
      generation.release();
    }
  });
}

it("re-validates the committed row after an unknown same-generation worker publication", async () => {
  await withUnknownPublication(async ({ generation }) => {
    for (let read = generation.prepareRead(); read; read = generation.prepareRead()) {
      await read;
    }
    expect(() => generation.assertCurrent()).not.toThrow();
    // Recovery is durable: later checks keep the re-read generation.
    expect(() => generation.assertCurrent()).not.toThrow();
    expect(generation.readSessionSettings()).toEqual({
      permissionMode: undefined,
      toolOverrides: undefined,
    });
  });
});

it("re-validates synchronously on the open native handle, as run authority checks do", async () => {
  await withUnknownPublication(({ generation }) => {
    expect(() => generation.assertCurrent()).not.toThrow();
    expect(() => generation.assertCurrent()).not.toThrow();
  });
});

it("still revokes when the committed row behind an unknown publication is deleted", async () => {
  await withUnknownPublication(({ generation, scope }) => {
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    database.db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(scope.sessionKey);
    expect(generation.assertCurrent).toThrow(
      expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
    );
  });
});

it("still revokes when the committed row behind an unknown publication is a new generation", async () => {
  await withUnknownPublication(async ({ generation, scope, original }) => {
    replaceSessionEntrySync(scope, { ...original, lifecycleRevision: "reset-lifecycle" });
    expect(generation.assertCurrent).toThrow(
      expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
    );
    // A revoked lease never recovers, even if the original values return.
    replaceSessionEntrySync(scope, original);
    expect(generation.assertCurrent).toThrow(
      expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
    );
  });
});
