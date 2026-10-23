import { expect, it } from "vitest";
import { retainSessionEntryWorkerPublication } from "../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { prepareSessionGenerationFacts } from "../config/sessions/session-delivery-generation.js";
import {
  getAgentRunContextOwnerStatus,
  resetAgentRunRegistryForTest,
} from "../infra/agent-run-registry.js";
import { findOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "./admitted-run-context.js";

// A queued follow-up run holds its session generation lease while the previous run's
// end-of-turn worker commit is still publishing. That window is transient: the run must
// refuse effects inside it without retiring its admitted authority.
async function withAdmittedRunOnGenerationLease(
  run: (params: {
    generation: Awaited<ReturnType<typeof prepareSessionGenerationFacts>>;
    prepared: ReturnType<typeof prepareAgentRunAdmission>;
    context: Awaited<ReturnType<ReturnType<typeof prepareAgentRunAdmission>["admit"]>>;
    beginPublication: () => { settle: () => void };
    scope: { agentId: string; storePath: string; sessionKey: string };
    original: { sessionId: string; lifecycleRevision: string; updatedAt: number };
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    resetAgentRunRegistryForTest();
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:dashboard:generation-pending",
    };
    const original = {
      sessionId: "f1234567-1234-1234-1234-123456789abc",
      lifecycleRevision: "original-lifecycle",
      updatedAt: 1,
    };
    replaceSessionEntrySync(scope, original);
    const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
    if (typeof identity !== "string") {
      throw new Error("Expected a file-backed agent database identity");
    }
    const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
    const runId = "generation-pending-run";
    const prepared = prepareAgentRunAdmission({
      cfg: {},
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "test", state: "present" },
      },
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      assertSourceCurrent: generation.assertCurrent,
    });
    try {
      const context = await prepared.admit("embedded");
      const beginPublication = () => {
        const publication = retainSessionEntryWorkerPublication({
          agentId: scope.agentId,
          storePath: scope.storePath,
          databaseIdentity: identity,
        });
        publication.begin([scope.sessionKey], []);
        return { settle: () => publication.settle(undefined, false) };
      };
      await run({ generation, prepared, context, beginPublication, scope, original });
    } finally {
      prepared.close();
      generation.release();
      resetAgentRunRegistryForTest();
    }
  });
}

it("keeps admitted run authority across a pending generation publication", async () => {
  await withAdmittedRunOnGenerationLease(
    async ({ generation, prepared, context, beginPublication }) => {
      const authority = getAdmittedRunDelegatedAuthority(context);
      expect(authority).toBeDefined();
      const assertActive = resolveAdmittedRunActiveAssertion(context);
      expect(assertActive).toBeDefined();

      const publication = beginPublication();
      // The effect inside the window is refused with the retryable storage failure.
      expect(() => assertActive!()).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
      );
      expect(() => prepared.assertSourceCurrent()).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
      );
      expect(getAdmittedRunDelegatedAuthority(context)).toBeUndefined();
      // The exact claim survives the refused checks.
      const { runId } = context.operationalRunInstance;
      expect(
        getAgentRunContextOwnerStatus(runId, authority!.claimId, authority!.lifecycleGeneration),
      ).toBeDefined();

      publication.settle();
      for (let read = generation.prepareRead(); read; read = generation.prepareRead()) {
        await read;
      }
      expect(getAdmittedRunDelegatedAuthority(context)).toBe(authority);
      expect(() => assertActive!()).not.toThrow();
      expect(() => prepared.assertSourceCurrent()).not.toThrow();
    },
  );
});

it("still retires admitted run authority when the session is reset", async () => {
  await withAdmittedRunOnGenerationLease(async ({ context, scope, original, prepared }) => {
    const authority = getAdmittedRunDelegatedAuthority(context);
    const assertActive = resolveAdmittedRunActiveAssertion(context);
    replaceSessionEntrySync(scope, { ...original, lifecycleRevision: "reset-lifecycle" });
    expect(() => assertActive!()).toThrow("admitted run authority is no longer active");
    expect(getAdmittedRunDelegatedAuthority(context)).toBeUndefined();
    expect(
      getAgentRunContextOwnerStatus(
        context.operationalRunInstance.runId,
        authority!.claimId,
        authority!.lifecycleGeneration,
      ),
    ).toBeUndefined();
    expect(() => prepared.assertSourceCurrent()).toThrow(
      "source execution authority is no longer active",
    );
  });
});

it("still retires admitted run authority when its generation lease is released", async () => {
  await withAdmittedRunOnGenerationLease(async ({ context, generation }) => {
    const authority = getAdmittedRunDelegatedAuthority(context);
    generation.release();
    // A released lease is unavailable but can never become current again.
    expect(getAdmittedRunDelegatedAuthority(context)).toBeUndefined();
    expect(
      getAgentRunContextOwnerStatus(
        context.operationalRunInstance.runId,
        authority!.claimId,
        authority!.lifecycleGeneration,
      ),
    ).toBeUndefined();
  });
});
