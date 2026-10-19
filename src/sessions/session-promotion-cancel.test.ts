import { describe, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  applySessionPromotionRequest,
  SessionPromotionCancelDeniedError,
} from "./session-promotion-state.js";

const key = "agent:main:dashboard:child";
const target = {
  agentId: "main",
  key,
  sessionId: "s1",
  fromLifecycleRevision: "r1",
};
const member = ["operator.sessions.write"];
const admin = ["operator.admin", "operator.sessions.write"];
const requester = (profileId: string, scopes: string[]) => ({
  version: 1 as const,
  actor: { kind: "operator" as const, profileId },
  scopes,
  grant: null,
});

function pendingEntry() {
  const entry = {
    sessionId: "s1",
    lifecycleRevision: "r1",
    spawnedBy: "agent:main:dashboard:root",
  } as never as Record<string, unknown>;
  applySessionPromotionRequest({
    entry: entry as never,
    target,
    requester: requester("alice", member),
    requestId: "request-1",
    now: 1,
    assertCurrent: () => {},
  });
  return entry;
}

function cancel(entry: Record<string, unknown>, who: ReturnType<typeof requester>) {
  return applySessionPromotionRequest({
    entry: entry as never,
    target,
    requester: who,
    requestId: "request-1",
    action: "cancel",
    now: 2,
    assertCurrent: () => {},
  });
}

describe("session promotion cancel authority", () => {
  it("lets the original requester cancel the pending intent", () => {
    const entry = pendingEntry();
    expect(cancel(entry, requester("alice", member)).state).toBe("cancelled");
  });

  it("refuses a cancel by another operator, even one who is an administrator", () => {
    const entry = pendingEntry();
    expect(() => cancel(entry, requester("bob", member))).toThrow(
      SessionPromotionCancelDeniedError,
    );
    expect(() => cancel(entry, requester("carol", admin))).toThrow(
      SessionPromotionCancelDeniedError,
    );
    expect(entry.sessionPromotion).toMatchObject({ state: "pending" });
  });

  it("lets the gateway owner cancel as an administrator", () => {
    const entry = pendingEntry();
    expect(cancel(entry, requester(GATEWAY_OWNER_PROFILE_ID, admin)).state).toBe("cancelled");
  });
});
