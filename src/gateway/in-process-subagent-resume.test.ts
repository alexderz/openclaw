import { expect, expectTypeOf, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions as CoreHandler } from "../plugin-sdk/core.js";
import type { GatewayRequestHandlerOptions as RuntimeHandler } from "../plugin-sdk/gateway-runtime.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import {
  bindInProcessSubagentResume,
  readInProcessSubagentResume,
  releaseParentSubagentResumeOnDispose,
} from "./in-process-subagent-resume.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it("keeps resume authority outside both public SDK handler types", () => {
  type CoreInternal = NonNullable<NonNullable<CoreHandler["client"]>["internal"]>;
  type RuntimeInternal = NonNullable<NonNullable<RuntimeHandler["client"]>["internal"]>;
  expectTypeOf<Extract<"subagentResume", keyof CoreInternal>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<"subagentResume", keyof RuntimeInternal>>().toEqualTypeOf<never>();
});

it("preserves private authority through principal capture but not copying or serialization", () => {
  let released = false;
  const assertChildRootCurrent = vi.fn(() => {
    if (released) {
      throw new Error("child root proof released");
    }
    return {
      proved: true as const,
      missing: false as const,
      promotedFrom: undefined,
      sessionId: "child-session",
      lifecycleRevision: null,
    };
  });
  const releaseChildRootProof = vi.fn(() => {
    released = true;
  });
  const resume = {
    caller: { agentId: "main", sessionKey: "agent:main:main", assertCurrent: vi.fn() },
    childSessionKey: "agent:main:dashboard:child",
    childSessionId: "child-session",
    previousRunId: "paused",
    taskRunId: "task",
    generation: 1,
    createdAt: 1,
    assertChildRootCurrent,
    releaseChildRootProof,
  };
  const client = createSyntheticPluginRuntimeClient();
  bindInProcessSubagentResume(client.internal!, resume);
  const captured = readInProcessSubagentResume(captureAgentTurnPrincipal(client)?.internal);
  expect(captured).toBe(resume);
  expect(captured?.assertChildRootCurrent()).toMatchObject({
    proved: true,
    missing: false,
    sessionId: resume.childSessionId,
  });
  expect(assertChildRootCurrent).toHaveBeenCalledOnce();
  expect(client.internal).not.toHaveProperty("subagentResume");
  expect(readInProcessSubagentResume({ ...client.internal })).toBeUndefined();
  expect(readInProcessSubagentResume(structuredClone(client.internal))).toBeUndefined();
  expect(JSON.stringify(client.internal)).not.toContain("subagentResume");
  expect(readInProcessSubagentResume({ subagentResume: resume })).toBeUndefined();
  releaseParentSubagentResumeOnDispose(captured)[Symbol.dispose]();
  expect(releaseChildRootProof).toHaveBeenCalledOnce();
  expect(() => captured?.assertChildRootCurrent()).toThrow("child root proof released");
});
