import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import type { SessionEffectiveAdmission } from "../../sessions/session-promotion-state.js";
import { captureSessionEffectiveAdmissionForTest } from "../../sessions/session-promotion-state.test-support.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import * as bundleMcp from "./bundle-mcp.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const claudeBackend: CliBackendPlugin & { pluginId: string } = {
  id: "claude-cli",
  pluginId: "anthropic",
  bundleMcp: true,
  bundleMcpMode: "claude-config-file",
  nativeToolMode: "selectable",
  toolAvailabilityEnforcement: "execution-args",
  resolveExecutionArgs: ({ baseArgs }) => [...baseArgs],
  config: {
    command: "claude",
    args: ["--print"],
    output: "jsonl",
    jsonlDialect: "claude-stream-json",
    input: "stdin",
    sessionMode: "existing",
  },
};

const sessionKey = "agent:main:dashboard:promoted-peer";
const sessionId = "promoted-cli-session";

function admissionOf(effectiveClass: "ordinary" | "delegated"): SessionEffectiveAdmission {
  return captureSessionEffectiveAdmissionForTest({ sessionKey, sessionId, effectiveClass });
}

describe("claude-cli preparation consumes the admitted session class", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const admissions: PreparedAgentRunAdmission[] = [];
  const bundleSpy = vi.spyOn(bundleMcp, "prepareCliBundleMcpConfig");

  beforeEach(() => {
    bundleSpy.mockClear();
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [claudeBackend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      makeBootstrapWarn: () => () => undefined,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      getActiveMcpLoopbackRuntime: () => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      }),
      createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
      mintMcpLoopbackClientGrant: createTestMcpLoopbackClientGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: () => true,
      resolveMcpLoopbackPolicyTools,
      resolveMcpLoopbackScopedTools,
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture((params) =>
      prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params }),
    );
    replaceSessionEntrySync(
      { storePath: fixture.session.sessionTarget.storePath, sessionKey },
      {
        sessionId,
        updatedAt: 1,
        spawnedBy: "agent:main:main",
        parentSessionKey: "agent:main:main",
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["read"],
        lifecycleRevision: "after-handoff",
      },
    );
  });

  afterEach(async () => {
    admissions.splice(0).forEach((admission) => admission.close());
    await fixture.settle();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
  });

  async function nativePolicyFor(admission: SessionEffectiveAdmission | undefined) {
    const { sessionTarget } = fixture.session;
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      { session: { store: sessionTarget.storePath } },
      "run-test",
      "main",
      "promotion-cli-prepare-test",
      undefined,
      admission
        ? createAdmittedRunOperatorAuthority({
            profileId: "human",
            scopes: [],
            assertCurrent() {},
            sessionEffectiveAdmission: admission,
          })
        : undefined,
    );
    admissions.push(preparedRunAdmission);
    const context = await fixture.prepare({
      sessionKey,
      sessionId,
      provider: "claude-cli",
      model: "opus",
      preparedRunAdmission,
      spawnedBy: "agent:main:main",
      config: { session: { store: sessionTarget.storePath } },
    });
    try {
      return bundleSpy.mock.calls.at(-1)?.[0].nativeMcpPolicy?.capabilityProfile.policy;
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  }

  it("drops the inherited delegated envelope for an ordinary admission", async () => {
    const policy = await nativePolicyFor(admissionOf("ordinary"));
    expect(policy?.delegated).toBe(false);
    expect(policy?.inheritedToolPolicy).toBeUndefined();
  });

  it("keeps a pre-handoff delegated admission delegated", async () => {
    const policy = await nativePolicyFor(admissionOf("delegated"));
    expect(policy?.delegated).toBe(true);
    expect(policy?.inheritedToolPolicy).toEqual({ allow: ["read"] });
  });

  it("keeps a run without a captured class delegated", async () => {
    const policy = await nativePolicyFor(undefined);
    expect(policy?.delegated).toBe(true);
  });
});
