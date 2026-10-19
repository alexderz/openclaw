import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { captureAdmittedChatSendSessionSettings } from "./chat-send-session-settings.js";

const key = "agent:main:dashboard:promotion";
function delegatedEntry(): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: 1,
    lifecycleRevision: "after",
    spawnedBy: "agent:main:main",
    inheritedToolAllow: ["read"],
    spawnDepth: 2,
    sessionPromotion: {
      version: 1,
      requestId: "request",
      acceptedAt: 1,
      boundary: "settlement-or-fresh-human-input",
      state: "activated",
      activatedAt: 2,
      target: { agentId: "main", key, sessionId: "session", fromLifecycleRevision: "before" },
      profileId: "human",
      toLifecycleRevision: "after",
    },
  };
}
function capture(entry: SessionEntry, profileId?: string, assertCurrent: () => void = vi.fn()) {
  return captureAdmittedChatSendSessionSettings({
    commit: true,
    entry,
    expectedPermissionMode: undefined,
    expectedToolOverrides: undefined,
    sessionKey: key,
    humanProfileId: profileId,
    assertCurrent,
  });
}
describe("promotion admission custody", () => {
  it("captures a fresh verified human ordinary admission without mutating historical fields", () => {
    const entry = delegatedEntry();
    const assertCurrent = vi.fn();
    const settings = capture(entry, "human", assertCurrent);
    expect(settings?.effectiveAdmission).toMatchObject({
      sessionId: "session",
      lifecycleRevision: "after",
      effectiveClass: "ordinary",
      humanProfileId: "human",
    });
    expect(assertCurrent).toHaveBeenCalled();
    expect(Object.isFrozen(settings?.effectiveAdmission)).toBe(true);
    expect(entry.inheritedToolAllow).toEqual(["read"]);
    expect(entry.spawnDepth).toBe(2);
  });
  it.each([undefined, "other"])(
    "does not promote a nonhuman or mismatching profile %s",
    (profile) => {
      expect(capture(delegatedEntry(), profile)?.effectiveAdmission?.effectiveClass).toBe(
        "delegated",
      );
    },
  );
  it("does not promote a receipt for a stale revision or another incarnation", () => {
    for (const change of [{ lifecycleRevision: "stale" }, { sessionId: "replacement" }]) {
      expect(
        capture({ ...delegatedEntry(), ...change }, "human")?.effectiveAdmission?.effectiveClass,
      ).toBe("delegated");
    }
  });
  it("never recaptures an existing handle when the row later activates", () => {
    const entry = delegatedEntry();
    delete entry.sessionPromotion;
    const queued = capture(entry, "human");
    Object.assign(entry, delegatedEntry());
    expect(capture(entry, "human")?.effectiveAdmission?.effectiveClass).toBe("ordinary");
    expect(queued?.effectiveAdmission?.effectiveClass).toBe("delegated");
  });
  it("fails closed when the prepared human authority is revoked", () => {
    expect(() =>
      capture(delegatedEntry(), "human", () => {
        throw new Error("revoked");
      }),
    ).toThrow("revoked");
  });
  it("keeps the historical class for input prepared under the pre-handoff identity", () => {
    const entry = delegatedEntry();
    const preparedBefore = captureAdmittedChatSendSessionSettings({
      commit: true,
      entry,
      expectedPermissionMode: undefined,
      expectedToolOverrides: undefined,
      sessionKey: key,
      humanProfileId: "human",
      admittedIdentity: { sessionId: "session", lifecycleRevision: "before" },
      assertCurrent: vi.fn(),
    });
    expect(preparedBefore?.effectiveAdmission?.effectiveClass).toBe("delegated");
    const preparedAfter = captureAdmittedChatSendSessionSettings({
      commit: true,
      entry,
      expectedPermissionMode: undefined,
      expectedToolOverrides: undefined,
      sessionKey: key,
      humanProfileId: "human",
      admittedIdentity: { sessionId: "session", lifecycleRevision: "after" },
      assertCurrent: vi.fn(),
    });
    expect(preparedAfter?.effectiveAdmission?.effectiveClass).toBe("ordinary");
  });
});
