import { expect, it } from "vitest";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  publishSessionEntryWorkerInvalidations,
  retainSessionEntryWorkerPublication,
} from "./session-accessor.sqlite-entry-worker-publication.js";
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
    identity: string;
  }) => void | Promise<void>,
  options: { closeNativeBeforePrepare?: true } = {},
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
    const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
    if (typeof identity !== "string") {
      throw new Error("Expected a file-backed agent database identity");
    }
    if (options.closeNativeBeforePrepare) {
      await closeOpenClawAgentDatabasesAsync();
    }
    const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
    try {
      generation.assertCurrent();
      publishSessionEntryWorkerInvalidations(
        { agentId: scope.agentId, storePath: scope.storePath, databaseIdentity: identity },
        [scope.sessionKey],
      );
      await run({ generation, scope, original, identity });
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

it("treats an undecodable committed row as unavailable, not as a revocation", async () => {
  await withUnknownPublication(({ generation, scope }) => {
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const select = database.db.prepare(
      "SELECT entry_json FROM session_nodes WHERE session_key = ?",
    );
    const { entry_json: committed } = select.get(scope.sessionKey) as { entry_json: string };
    const write = database.db.prepare(
      "UPDATE session_nodes SET entry_json = ? WHERE session_key = ?",
    );
    write.run('{"undecodable":', scope.sessionKey);
    expect(generation.assertCurrent).toThrow(
      expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
    );
    // The lease was not revoked: the decodable original row still re-validates it.
    write.run(committed, scope.sessionKey);
    expect(() => generation.assertCurrent()).not.toThrow();
  });
});

it("reports a revocation found by prepareRead as a rejected read, not a synchronous throw", async () => {
  await withUnknownPublication(async ({ generation, scope, original }) => {
    replaceSessionEntrySync(scope, { ...original, lifecycleRevision: "reset-lifecycle" });
    let read: Promise<void> | undefined;
    expect(() => {
      read = generation.prepareRead();
    }).not.toThrow();
    await expect(read).rejects.toMatchObject({ code: "SESSION_DELIVERY_GENERATION_REVOKED" });
    expect(generation.assertCurrent).toThrow(
      expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
    );
  });
});

it("defers recovery while a publication for the key is pending", async () => {
  await withUnknownPublication(async ({ generation, scope, identity }) => {
    const publication = retainSessionEntryWorkerPublication({
      agentId: scope.agentId,
      storePath: scope.storePath,
      databaseIdentity: identity,
    });
    publication.begin([scope.sessionKey], []);
    // The committed row is unchanged, but a pending writer may still change it.
    expect(generation.assertCurrent).toThrow(
      expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
    );
    const read = generation.prepareRead();
    expect(read).toBeInstanceOf(Promise);
    publication.settle(undefined, false);
    await read;
    for (let next = generation.prepareRead(); next; next = generation.prepareRead()) {
      await next;
    }
    expect(() => generation.assertCurrent()).not.toThrow();
  });
});

it("stays unavailable when no native main-thread handle was open at capture", async () => {
  await withUnknownPublication(
    async ({ generation, scope }) => {
      // Worker-only capture: no main-thread handle can certify a committed re-read,
      // so the unknown generation fails closed exactly as before DER-594.
      expect(getOpenClawAgentDatabaseIfOpen({ agentId: scope.agentId })).toBeUndefined();
      expect(generation.prepareRead()).toBeUndefined();
      expect(generation.assertCurrent).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
      );
    },
    { closeNativeBeforePrepare: true },
  );
});
