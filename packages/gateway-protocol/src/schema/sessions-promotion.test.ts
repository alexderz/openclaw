import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import * as sessions from "./sessions.js";

const input = {
  key: "agent:main:dashboard:visible",
  expectedSessionId: "incarnation",
  expectedLifecycleRevision: "revision",
  requestId: "request-1",
};
describe("sessions.promote schema", () => {
  it("registers a strict human mutation contract", () => {
    const schema = Reflect.get(sessions, "SessionsPromoteParamsSchema");
    expect(schema, "promotion mutation must have a registered schema").toBeDefined();
    expect(Value.Check(schema, input)).toBe(true);
    expect(Value.Check(schema, { ...input, action: "cancel" })).toBe(true);
    for (const patch of [
      { principal: "owner" },
      { effectiveClass: "ordinary" },
      { action: "activate" },
      { expectedLifecycleRevision: "" },
      { requestId: "x".repeat(129) },
    ]) {
      expect(Value.Check(schema, { ...input, ...patch })).toBe(false);
    }
  });
});
