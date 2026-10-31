import fs from "node:fs";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindMcpLoopbackClientGrantAdmission,
  type mintMcpLoopbackClientGrant as MintMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import { handleMcpJsonRpc } from "../../gateway/mcp-http.handlers.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import { buildMcpToolSchema } from "../../gateway/mcp-http.schema.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveBundleMcpServerInstructions } from "../agent-bundle-mcp-instructions.js";
import {
  peekSessionMcpRuntime,
  retireSessionMcpRuntime,
  setSessionMcpRuntimeScheduler,
} from "../agent-bundle-mcp-manager-api.js";
import { disposeAllSessionMcpRuntimes } from "../agent-bundle-mcp-tools.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { getTextContent } from "../test-helpers/agent-tools-fs-helpers.js";
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

async function startProbeServer() {
  const state = { calls: 0 };
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        response.writeHead(request.method === "DELETE" ? 200 : 405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; arguments?: { word?: string } };
      };
      if (message.method === "tools/call") {
        state.calls += 1;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "probe", version: "1" },
              instructions: "PROBE_GUIDANCE: echo one word per call.",
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    description: "Echo a word.",
                    inputSchema: { type: "object", properties: { word: { type: "string" } } },
                  },
                ],
              }
            : message.method === "tools/call"
              ? {
                  content: [{ type: "text", text: `probe:${message.params?.arguments?.word}` }],
                }
              : undefined;
      if (!result) {
        response.writeHead(202).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP probe server did not acquire a loopback port");
  }
  return {
    port: address.port,
    get calls() {
      return state.calls;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("configured MCP servers on exclusive CLI turns", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const mintGrant = vi.fn<typeof MintMcpLoopbackClientGrant>();

  beforeEach(() => {
    mintGrant.mockReset().mockImplementation(createTestMcpLoopbackClientGrant);
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
      mintMcpLoopbackClientGrant: mintGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: () => true,
      resolveMcpLoopbackPolicyTools,
      resolveMcpLoopbackScopedTools,
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture((params) => {
      setRuntimeConfigSnapshot(params.config ?? {});
      return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
    });
  });

  afterEach(async () => {
    await fixture.settle();
    clearRuntimeConfigSnapshot();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
  });

  it.each([
    { name: "allowed", allow: ["read", "probe__*"], deny: [] as string[], childAllow: undefined },
    { name: "denied", allow: ["read", "probe__*"], deny: ["probe__*"], childAllow: undefined },
    { name: "requester-capped", allow: ["read", "probe__*"], deny: [], childAllow: ["read"] },
  ])(
    "serves $name configured MCP servers through the loopback on every turn",
    async ({ allow, deny, childAllow }) => {
      const { sessionTarget } = fixture.session;
      const probeServer = await startProbeServer();
      const childSessionKey = "agent:main:subagent:configured-mcp";
      replaceSessionEntrySync(
        { storePath: sessionTarget.storePath, sessionKey: childSessionKey },
        {
          sessionId: "configured-mcp-child",
          updatedAt: 1,
          spawnedBy: sessionTarget.sessionKey,
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: childAllow ?? allow,
        },
      );
      const config: OpenClawConfig = {
        session: { store: sessionTarget.storePath },
        plugins: { enabled: false },
        tools: { allow, deny },
        mcp: {
          servers: {
            probe: {
              transport: "streamable-http",
              url: `http://127.0.0.1:${probeServer.port}/mcp`,
            },
          },
        },
      };
      const turns = [];
      const scheduler = createTestGatewayScheduler();
      try {
        await setSessionMcpRuntimeScheduler(scheduler);
        for (const completion of [false, true, false]) {
          const context = await fixture.prepare({
            sessionKey: sessionTarget.sessionKey,
            sessionId: sessionTarget.sessionId,
            provider: "claude-cli",
            model: "opus",
            modelHasVision: false,
            sourceReplyDeliveryMode: "automatic",
            config,
            ...(completion
              ? {
                  trustedInternalHandoff: {
                    kind: "subagent-completion" as const,
                    sourceSessionKey: childSessionKey,
                    sourceSessionId: "configured-mcp-child",
                    targetSessionKey: sessionTarget.sessionKey,
                    targetSessionId: sessionTarget.sessionId,
                    provider: "claude-cli",
                    model: "opus",
                  },
                  inputProvenance: {
                    kind: "inter_session" as const,
                    sourceTool: "subagent_announce",
                    sourceSessionKey: childSessionKey,
                  },
                }
              : {}),
          });
          try {
            const minted = mintGrant.mock.lastCall?.[0];
            const args = context.preparedBackend.backend.args ?? [];
            const bundle = JSON.parse(
              fs.readFileSync(args[args.indexOf("--mcp-config") + 1] ?? "", "utf-8"),
            ) as { mcpServers: Record<string, unknown> };
            // The CLI never reaches the configured server directly.
            expect(Object.keys(bundle.mcpServers)).toEqual(["openclaw"]);
            const scoped = minted
              ? await resolveMcpLoopbackScopedTools({
                  cfg: config,
                  context: minted.context,
                  admittedRunContext: context.params.admittedRunContext,
                  ...(minted.bundledTools ? { bundledTools: minted.bundledTools } : {}),
                })
              : { tools: [] };
            const probe = scoped.tools.find((tool) => tool.name === "probe__echo");
            const initialized = (await handleMcpJsonRpc({
              message: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
              tools: scoped.tools,
              toolSchema: buildMcpToolSchema(scoped.tools),
              serverInstructions: resolveBundleMcpServerInstructions(
                minted?.bundledTools,
                new Set(buildMcpToolSchema(scoped.tools).map((entry) => entry.name)),
              ),
            })) as { result: { instructions?: string } };
            turns.push({
              toolsAllow: minted?.context.toolsAllow?.toSorted(),
              listed: scoped.tools.map((tool) => tool.name).toSorted(),
              instructions: initialized.result.instructions,
              result: probe
                ? getTextContent(await probe.execute("configured-mcp", { word: "pong" }))
                : undefined,
            });
          } finally {
            await context.preparedBackend.cleanup?.();
          }
        }
      } finally {
        await disposeAllSessionMcpRuntimes();
        await scheduler.stop();
        await probeServer.close();
      }
      const expectedTools = deny.length > 0 ? ["read"] : ["probe__echo", "read"];
      expect(turns[0]).toEqual({
        toolsAllow: expectedTools,
        listed: expectedTools,
        // Native Claude saw the server's guidance; the bridge keeps it, unless
        // the server has no listed tools.
        instructions:
          deny.length > 0 ? undefined : "## probe\nPROBE_GUIDANCE: echo one word per call.",
        result: deny.length > 0 ? undefined : "probe:pong",
      });
      // One catalog for ordinary and completion turns keeps the Claude prefix stable.
      // A capped completion keeps the definition but refuses the call before the server.
      expect(turns[1]).toEqual(
        childAllow
          ? {
              ...turns[0],
              result:
                "probe__echo is outside the authority this completion turn carries from its requester. Do not retry probe__echo.",
            }
          : turns[0],
      );
      expect(turns[2]).toEqual(turns[0]);
      expect(probeServer.calls).toBe(deny.length > 0 ? 0 : childAllow ? 2 : 3);
    },
  );
});

// In-memory ownership probe: no MCP transport, provider, or network is used.
describe("configured MCP disposer ownership", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  let dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let revoke: ReturnType<typeof vi.fn>;
  let backendCleanup: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let events: string[];
  let owned: boolean;
  let prepareBackend: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    events = [];
    owned = true;
    dispose = vi.fn(async () => { events.push("dispose"); });
    revoke = vi.fn(() => { events.push("revoke"); return true; });
    backendCleanup = vi.fn(async () => { events.push("backend"); });
    const loopback = await import("./loopback-bundle-mcp.js");
    vi.spyOn(loopback, "prepareCliLoopbackBundleMcp").mockImplementation(async () => ({
      tools: [],
      takeCleanup: () => { owned = false; return dispose; },
      [Symbol.asyncDispose]: async () => { if (owned) { owned = false; await dispose(); } },
    }));
    const bundle = await import("./bundle-mcp.js");
    prepareBackend = vi.spyOn(bundle, "prepareCliBundleMcpConfig").mockImplementation(async (params) => ({
      backend: params.backend,
      env: params.env,
      cleanup: backendCleanup,
    }));
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [claudeBackend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      makeBootstrapWarn: () => () => undefined,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      getActiveMcpLoopbackRuntime: () => ({ port: 31783, ownerToken: "owner", nonOwnerToken: "other" }),
      createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
      mintMcpLoopbackClientGrant: createTestMcpLoopbackClientGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: revoke,
      resolveMcpLoopbackPolicyTools: () => ({ agentId: "main", tools: [] }),
      resolveMcpLoopbackScopedTools: () => ({ agentId: "main", tools: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture((params) =>
      prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params }),
    );
  });
  afterEach(async () => {
    await fixture.settle();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    vi.restoreAllMocks();
  });
  const prepare = () => fixture.prepare({
    sessionKey: "agent:main:main",
    provider: "claude-cli",
    model: "opus",
    config: { plugins: { enabled: false } },
    cliToolAvailability: { native: [], openClaw: [] },
  });

  it("releases the transferred owner after backend cleanup and revocation", async () => {
    const context = await prepare();
    expect(dispose).not.toHaveBeenCalled();
    await context.preparedBackend.cleanup?.();
    expect(events).toEqual(["backend", "revoke", "dispose"]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("loopback-token");
  });
  it("releases and revokes when backend cleanup fails", async () => {
    backendCleanup.mockImplementation(async () => { events.push("backend"); throw new Error("backend cleanup"); });
    const context = await prepare();
    await expect(context.preparedBackend.cleanup?.()).rejects.toThrow("backend cleanup");
    expect(events).toEqual(["backend", "revoke", "dispose"]);
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("releases and revokes if backend setup fails after transfer", async () => {
    prepareBackend.mockRejectedValueOnce(new Error("setup failure"));
    await expect(prepare()).rejects.toThrow("setup failure");
    expect(events).toEqual(["revoke", "dispose"]);
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("denies a revoked admission and still cleans the transferred resources", async () => {
    setCliRunnerPrepareTestDeps({ bindMcpLoopbackClientGrantAdmission: () => false });
    await expect(prepare()).rejects.toThrow("CLI MCP client grant is no longer valid");
    expect(events).toEqual(["backend", "revoke", "dispose"]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("loopback-token");
  });
  it("preserves an abort raised after transfer while cleaning up", async () => {
    const abort = new Error("owner aborted");
    abort.name = "AbortError";
    prepareBackend.mockRejectedValueOnce(abort);
    await expect(prepare()).rejects.toBe(abort);
    expect(events).toEqual(["revoke", "dispose"]);
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("still releases if revocation throws", async () => {
    revoke.mockImplementation(() => { events.push("revoke"); throw new Error("revocation failure"); });
    const context = await prepare();
    await expect(context.preparedBackend.cleanup?.()).rejects.toThrow("revocation failure");
    expect(events).toEqual(["backend", "revoke", "dispose"]);
    expect(dispose).toHaveBeenCalledOnce();
  });
});


describe("configured MCP real lifecycle", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  let server: Awaited<ReturnType<typeof startProbeServer>>;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  let token: string;
  let abortDuringBackend: (() => void) | undefined;

  beforeEach(async () => {
    token = "";
    abortDuringBackend = undefined;
    server = await startProbeServer();
    scheduler = createTestGatewayScheduler();
    await setSessionMcpRuntimeScheduler(scheduler);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [claudeBackend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      makeBootstrapWarn: () => () => undefined,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      getActiveMcpLoopbackRuntime: () => ({ port: 31783, ownerToken: "real-owner", nonOwnerToken: "other" }),
      createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
      resolveMcpLoopbackPolicyTools,
      resolveMcpLoopbackScopedTools,
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    const bundle = await import("./bundle-mcp.js");
    vi.spyOn(bundle, "prepareCliBundleMcpConfig").mockImplementation(async (params) => {
      token = params.env?.OPENCLAW_MCP_TOKEN ?? "";
      abortDuringBackend?.();
      return { backend: params.backend, env: params.env, cleanup: async () => {} };
    });
    fixture = createCliRunnerPrepareFixture((params) => {
      setRuntimeConfigSnapshot(params.config ?? {});
      return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
    });
  });

  afterEach(async () => {
    await fixture.settle();
    await disposeAllSessionMcpRuntimes();
    await scheduler.stop();
    await server.close();
    clearRuntimeConfigSnapshot();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    vi.restoreAllMocks();
  });

  const prepare = (abortSignal?: AbortSignal) => {
    const { sessionTarget } = fixture.session;
    return fixture.prepare({
      sessionKey: sessionTarget.sessionKey,
      sessionId: sessionTarget.sessionId,
      provider: "claude-cli",
      model: "opus",
      modelHasVision: false,
      abortSignal,
      ...(abortSignal ? { assertCurrent: () => abortSignal.throwIfAborted() } : {}),
      config: {
        session: { store: sessionTarget.storePath },
        plugins: { enabled: false },
        tools: { allow: ["read", "probe__*"] },
        mcp: { servers: { probe: { transport: "streamable-http", url: `http://127.0.0.1:${server.port}/mcp` } } },
      },
    });
  };

  it("releases the real lease and grant, preserving a shared runtime until retirement", async () => {
    const context = await prepare();
    const { sessionTarget } = fixture.session;
    const runtime = peekSessionMcpRuntime({ sessionId: sessionTarget.sessionId });
    expect(runtime).toBeDefined();
    expect(runtime!.activeLeases).toBe(1);
    expect(token).not.toBe("");
    const admission = context.params.admittedRunContext!;
    const binding = { token, runtimeOwnerToken: "real-owner", admittedRunContext: admission };
    expect(bindMcpLoopbackClientGrantAdmission(binding)).toBe(true);
    await context.preparedBackend.cleanup?.();
    expect(runtime!.activeLeases).toBe(0);
    expect(bindMcpLoopbackClientGrantAdmission(binding)).toBe(false);
    expect(peekSessionMcpRuntime({ sessionId: sessionTarget.sessionId })).toBe(runtime);
    await context.preparedBackend.cleanup?.();
    expect(runtime!.activeLeases).toBe(0);
    expect(peekSessionMcpRuntime({ sessionId: sessionTarget.sessionId })).toBe(runtime);
    const next = await prepare();
    expect(peekSessionMcpRuntime({ sessionId: sessionTarget.sessionId })).toBe(runtime);
    expect(runtime!.activeLeases).toBe(1);
    expect(await retireSessionMcpRuntime({
      sessionId: sessionTarget.sessionId, reason: "test", preserveActiveLeases: true,
    })).toBe(true);
    expect(runtime!.activeLeases).toBe(1);
    expect(peekSessionMcpRuntime({ sessionId: sessionTarget.sessionId })).toBe(runtime);
    await next.preparedBackend.cleanup?.();
    expect(runtime!.activeLeases).toBe(0);
    expect(peekSessionMcpRuntime({ sessionId: sessionTarget.sessionId })).toBeUndefined();
  });

  it("releases the real transferred lease when an AbortController fires", async () => {
    const controller = new AbortController();
    const reason = new Error("owner aborted after transfer");
    let runtime: ReturnType<typeof peekSessionMcpRuntime>;
    abortDuringBackend = () => {
      runtime = peekSessionMcpRuntime({ sessionId: fixture.session.sessionTarget.sessionId });
      expect(runtime?.activeLeases).toBe(1);
      controller.abort(reason);
    };
    await expect(prepare(controller.signal)).rejects.toBe(reason);
    expect(runtime).toBeDefined();
    expect(runtime!.activeLeases).toBe(0);
  });
});
