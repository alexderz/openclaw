import { expect, it, vi } from "vitest";
import { TerminalSessionManager } from "./session-manager.js";
import { makeFakePty } from "./session-manager.test-helpers.js";

it("exposes an owner-backed read-only inventory without closing terminal admissions", () => {
  const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => makeFakePty() });
  expect(manager.inspectAgentSessionWork).toBeTypeOf("function");
  const owner = {
    kind: "agent" as const,
    sessionKey: "agent:main:subagent:promotion",
    sessionId: "session-promotion",
    lifecycleRevision: "1",
  };
  expect(manager.inspectAgentSessionWork(owner)).toBe(false);
});
