import { afterEach, describe, expect, it } from "vitest";
import {
  peekToolsEffectiveRestrictions,
  recordToolsEffectiveRestrictions,
  testing,
} from "./tools-effective-restrictions.js";

const summary = (evaluatedAt: number) => ({
  evaluatedClass: "delegated" as const,
  limitedTools: [{ id: "exec", origins: ["inherited-limit" as const] }],
  sessionsSend: "denied" as const,
  evaluatedAt,
});
const identity = {
  sessionKey: "agent:main:subagent:child",
  sessionId: "session",
  lifecycleRevision: "rev-1",
  configKey: "runtime:1:abc",
};

describe("tools.effective restriction index", () => {
  afterEach(() => testing.resetToolsEffectiveRestrictionsForTest());

  it("serves a summary only to the same session revision and runtime config", () => {
    recordToolsEffectiveRestrictions({ ...identity, summary: summary(1) });
    expect(peekToolsEffectiveRestrictions(identity)).toEqual(summary(1));
    expect(peekToolsEffectiveRestrictions({ ...identity, sessionId: "reset" })).toBeUndefined();
    expect(
      peekToolsEffectiveRestrictions({ ...identity, lifecycleRevision: "promoted" }),
    ).toBeUndefined();
    expect(
      peekToolsEffectiveRestrictions({ ...identity, configKey: "runtime:2:def" }),
    ).toBeUndefined();
    expect(
      peekToolsEffectiveRestrictions({ ...identity, sessionKey: "agent:main:main" }),
    ).toBeUndefined();
  });

  it("keeps the newest evaluation when a slower older one lands later", () => {
    recordToolsEffectiveRestrictions({ ...identity, summary: summary(5) });
    recordToolsEffectiveRestrictions({ ...identity, summary: summary(3) });
    expect(peekToolsEffectiveRestrictions(identity)?.evaluatedAt).toBe(5);
    recordToolsEffectiveRestrictions({ ...identity, summary: undefined });
    expect(peekToolsEffectiveRestrictions(identity)?.evaluatedAt).toBe(5);
  });
});
