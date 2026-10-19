import { describe, expect, it } from "vitest";
import { normalizeSessionEntryTimestamp } from "./session-accessor.sqlite-session-row.js";

const requester = {
  version: 1,
  actor: { kind: "operator", profileId: "human" },
  scopes: ["operator.sessions.write"],
  grant: null,
};
const intent = {
  version: 1,
  state: "pending",
  requestId: "request-1",
  acceptedAt: 1,
  target: {
    agentId: "main",
    key: "agent:main:dashboard:visible",
    sessionId: "session",
    fromLifecycleRevision: "before",
  },
  requester,
  boundary: "settlement-or-fresh-human-input",
};
function restore(sessionPromotion: unknown) {
  return normalizeSessionEntryTimestamp({
    sessionId: "session",
    updatedAt: 1,
    lifecycleRevision: "before",
    sessionPromotion,
  } as never);
}
describe("durable promotion persistence", () => {
  it("round trips the human pending intent without manufacturing credentials", () => {
    expect(restore(intent)?.sessionPromotion).toEqual(intent);
  });
  it("rejects impossible activation receipts and unsupported historical targets", () => {
    const receipt = {
      version: 1,
      state: "activated",
      requestId: "request-1",
      acceptedAt: 1,
      target: intent.target,
      boundary: intent.boundary,
      profileId: "human",
      activatedAt: 2,
      toLifecycleRevision: "after",
    };
    expect(restore(receipt)?.sessionPromotion).toEqual(receipt);
    // An administrator may promote a subagent-key session; its intent persists like any other.
    const subagent = { ...intent, target: { ...intent.target, key: "agent:main:subagent:task" } };
    expect(restore(subagent)?.sessionPromotion).toEqual(subagent);
    for (const record of [
      { ...receipt, toLifecycleRevision: "before" },
      { ...receipt, activatedAt: 0 },
      { ...intent, target: { ...intent.target, key: "agent:main:subagent:incognito-hidden" } },
      { ...intent, target: { ...intent.target, agentId: "other" } },
    ]) {
      expect(restore(record)?.sessionPromotion).toBeUndefined();
    }
  });
  it("fails closed on malformed and credential-bearing records", () => {
    for (const record of [
      { ...intent, version: 2 },
      { ...intent, bearer: "secret" },
      { ...intent, requester: { ...requester, actor: { kind: "system" } } },
      { ...intent, target: { ...intent.target, sessionId: "" } },
    ]) {
      expect(restore(record)?.sessionPromotion).toBeUndefined();
    }
  });
});
