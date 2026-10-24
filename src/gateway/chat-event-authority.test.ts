import { afterEach, expect, it } from "vitest";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { stampChatEventAuthorityClass } from "./chat-event-authority.js";

afterEach(() => {
  clearAgentRunContext("typed-run");
  clearAgentRunContext("untyped-run");
});

it("stamps chat events with the class the run's typed turn was admitted under", () => {
  registerAgentRunContext("typed-run", {
    sessionKey: "agent:main:main",
    authorityClass: "delegated",
  });
  registerAgentRunContext("untyped-run", { sessionKey: "agent:main:main" });
  const event = { runId: "typed-run", sessionKey: "agent:main:main", seq: 1, state: "final" };
  expect(stampChatEventAuthorityClass(event)).toEqual({ ...event, authorityClass: "delegated" });
  expect(event).not.toHaveProperty("authorityClass");
  const untyped = { ...event, runId: "untyped-run" };
  expect(stampChatEventAuthorityClass(untyped)).toBe(untyped);
  const unknown = { ...event, runId: "no-such-run" };
  expect(stampChatEventAuthorityClass(unknown)).toBe(unknown);
});
