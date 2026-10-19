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
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

type GatewayCall = { method?: string; params?: Record<string, unknown> };
const gatewayCalls = vi.hoisted(() => [] as GatewayCall[]);
// sessions_send reaches the Gateway through the in-process agent-tool caller; record, never dispatch.
// 10.5 binds the send caller at dispatch, so both entry points record the same way.
const { recordGatewayCall } = vi.hoisted(() => ({
  recordGatewayCall: async (request: GatewayCall): Promise<never> => {
    gatewayCalls.push(request);
    if (request.method === "agent") {
      return { runId: "target-run", status: "accepted" } as never;
    }
    return (request.method === "agent.wait" ? { status: "timeout" } : {}) as never;
  },
}));
vi.mock("../tools/in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/in-process-gateway.js")>()),
  callAgentToolGatewayRequest: recordGatewayCall,
  bindAgentToolGatewayRequest: () => recordGatewayCall,
}));

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
const targetKey = "agent:main:main";

type LoopbackScope = Parameters<typeof resolveMcpLoopbackScopedTools>[0];
type LoopbackResult = Awaited<ReturnType<typeof resolveMcpLoopbackScopedTools>>;

describe("claude-cli run reaches sessions_send through the MCP loopback with its admitted class", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const admissions: PreparedAgentRunAdmission[] = [];
  const loopback: { scope: LoopbackScope; result: LoopbackResult }[] = [];
  const record =
    (resolve: typeof resolveMcpLoopbackScopedTools) =>
    async (scope: LoopbackScope): Promise<LoopbackResult> => {
      const result = await resolve(scope);
      loopback.push({ scope, result });
      return result;
    };

  beforeEach(() => {
    gatewayCalls.length = 0;
    loopback.length = 0;
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
      resolveMcpLoopbackPolicyTools: record(resolveMcpLoopbackPolicyTools),
      resolveMcpLoopbackScopedTools: record(resolveMcpLoopbackScopedTools),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture((params) =>
      prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params }),
    );
    // The promoted row still carries its historical spawn lineage and an inherited allowlist
    // that permits sessions_send, so only the admitted class decides the messaging semantics.
    replaceSessionEntrySync(
      { storePath: fixture.session.sessionTarget.storePath, sessionKey },
      {
        sessionId,
        updatedAt: 1,
        spawnedBy: targetKey,
        parentSessionKey: targetKey,
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["read", "sessions_send"],
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

  async function sendThroughLoopback(admission: SessionEffectiveAdmission | undefined) {
    const { sessionTarget } = fixture.session;
    const config = {
      session: { store: sessionTarget.storePath },
      tools: { sessions: { visibility: "all" as const } },
    };
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      config,
      "run-test",
      "main",
      "promotion-cli-sessions-send-test",
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
      spawnedBy: targetKey,
      config,
    });
    try {
      const resolved = loopback.at(-1);
      expect(resolved, "CLI prepare must resolve the loopback catalog").toBeDefined();
      // The catalog was built from the run's own admitted context, carrying the exact handle.
      const admitted: AdmittedRunContext | undefined = resolved?.scope.admittedRunContext;
      expect(admitted?.sessionEffectiveAdmission).toBe(admission);
      const sessionsSend = resolved?.result.tools.find((tool) => tool.name === "sessions_send");
      if (!sessionsSend) {
        // The delegated envelope always denies sessions_send (SUBAGENT_TOOL_DENY_ALWAYS).
        return { onCatalog: false as const };
      }
      gatewayCalls.length = 0;
      const result = await sessionsSend.execute("promotion-cli", {
        sessionKey: targetKey,
        message: "hello from the promoted conversation",
        timeoutSeconds: 0,
      });
      expect(result.details).toMatchObject({ status: "accepted" });
      const agentCall = gatewayCalls.find((call) => call.method === "agent");
      expect(agentCall).toBeDefined();
      return {
        onCatalog: true as const,
        sourceRole: (agentCall?.params?.inputProvenance as { sourceRole?: string } | undefined)
          ?.sourceRole,
      };
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  }

  it("sends with ordinary semantics for a run admitted after activation", async () => {
    const sent = await sendThroughLoopback(
      captureSessionEffectiveAdmissionForTest({
        sessionKey,
        sessionId,
        effectiveClass: "ordinary",
      }),
    );
    // Peer semantics: no subagent source role, exactly as a newly created dashboard session.
    expect(sent).toEqual({ onCatalog: true, sourceRole: undefined });
  });

  it("keeps a run admitted before the handoff delegated", async () => {
    const sent = await sendThroughLoopback(
      captureSessionEffectiveAdmissionForTest({
        sessionKey,
        sessionId,
        effectiveClass: "delegated",
      }),
    );
    expect(sent).toEqual({ onCatalog: false });
  });

  it("keeps a look-alike ordinary handle the owner did not mint delegated", async () => {
    const minted = captureSessionEffectiveAdmissionForTest({
      sessionKey,
      sessionId,
      effectiveClass: "ordinary",
    });
    expect(await sendThroughLoopback(Object.freeze({ ...minted }))).toEqual({ onCatalog: false });
  });

  it("keeps a run without a captured class delegated", async () => {
    expect(await sendThroughLoopback(undefined)).toEqual({ onCatalog: false });
  });
});
