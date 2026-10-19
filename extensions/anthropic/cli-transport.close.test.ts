import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import * as cliProcess from "./cli-process.js";
import { createClaudeCliTransport } from "./cli-transport.js";

type ClaudeChild = Awaited<
  ReturnType<ReturnType<typeof cliProcess.createClaudeCliProcessOwner>["spawn"]>
>;

afterEach(() => vi.restoreAllMocks());

it("waits for Windows tree extinction before ending stdin", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const extinction = createDeferred<void>();
  const output = createDeferred<void>();
  const exit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  let onExit: Parameters<ClaudeChild["onExit"]>[0] | undefined;
  const calls: string[] = [];
  const child: ClaudeChild = {
    supportsRawOutput: true,
    stdin: {
      write: (_data, callback) => callback?.(),
      end: () => {
        calls.push("EOF");
      },
    },
    onStdout: () => {},
    onStderr: () => {},
    onError: () => {},
    onExit: (listener) => {
      onExit = listener;
    },
    consumeStdout: () => output.promise,
    wait: () => exit.promise,
    waitForExtinction: () => extinction.promise,
    kill: (signal) => {
      calls.push(signal ?? "SIGTERM");
    },
    dispose: () => {},
  };
  vi.spyOn(cliProcess, "createClaudeCliProcessOwner").mockReturnValue({
    spawn: async () => child,
    withDiagnostics: async (error: unknown) => error,
    [Symbol.dispose]: () => {},
  });
  // 10.5 transports take the whole execution context; only the spawn fields matter here.
  const context: CliBackendExecuteContext = {
    command: "claude",
    args: [],
    cwd: ".",
    env: {},
    prompt: "",
    systemPrompt: "",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    timeoutMs: 10_000,
    requestToolPermission: async () => ({ behavior: "deny", message: "No tools here." }),
    requestUserInput: async () => ({ status: "cancelled", message: "No input here." }),
  };
  const transport = await createClaudeCliTransport({
    context,
    args: [],
    initialize: {},
    currentContext: () => context,
    onMessage: async () => {},
    onRequest: async () => () => ({}),
    onError: () => {},
  });
  try {
    transport.close();
    expect(calls).toEqual(["SIGKILL"]);
    extinction.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["SIGKILL", "EOF"]);
  } finally {
    extinction.resolve();
    onExit?.(null, "SIGKILL");
    exit.resolve({ code: null, signal: "SIGKILL" });
    output.resolve();
    await transport.waitForExit();
  }
});
