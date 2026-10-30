import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { stampChatEventAuthorityClass } from "../chat-event-authority.js";
import { typedTurnAuthorityClass } from "./chat-send-promotion-boundary.js";
import { captureAdmittedChatSendSessionSettings } from "./chat-send-session-settings.js";

const key = "agent:main:dashboard:promotion";
function delegatedEntry(sessionKey = key): SessionEntry {
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
      target: {
        agentId: "main",
        key: sessionKey,
        sessionId: "session",
        fromLifecycleRevision: "before",
      },
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

describe("typed turn authority class", () => {
  const typed = {
    systemInputProvenance: undefined,
    systemProvenanceReceipt: undefined,
    goalOperation: undefined,
    stopCommand: false,
    providerReviewAcknowledgment: undefined,
  };
  it("stamps the class captured for the run, ordinary only after verified promotion", () => {
    expect(typedTurnAuthorityClass(typed, capture(delegatedEntry(), "human"))).toBe("ordinary");
    expect(typedTurnAuthorityClass(typed, capture(delegatedEntry(), "other"))).toBe("delegated");
    expect(typedTurnAuthorityClass(typed, capture({ sessionId: "root", updatedAt: 1 }))).toBe(
      "ordinary",
    );
  });
  it("leaves non-typed turns and turns without an admission unstamped", () => {
    const settings = capture(delegatedEntry());
    expect(
      typedTurnAuthorityClass(
        { ...typed, systemInputProvenance: { kind: "inter_session" } as never },
        settings,
      ),
    ).toBeUndefined();
    expect(typedTurnAuthorityClass({ ...typed, stopCommand: true }, settings)).toBeUndefined();
    expect(typedTurnAuthorityClass(typed, undefined)).toBeUndefined();
  });
});

describe("typed turn authority follows the tool class", () => {
  const typed = {
    systemInputProvenance: undefined,
    systemProvenanceReceipt: undefined,
    goalOperation: undefined,
    stopCommand: false,
    providerReviewAcknowledgment: undefined,
  };
  const promotedKey = "agent:main:subagent:promoted";
  const cases: Array<{
    name: string;
    sessionKey: string;
    entry: SessionEntry;
    profileId?: string;
    expected: "ordinary" | "delegated";
    admissionClass?: "ordinary" | "delegated";
  }> = [
    {
      name: "orphan subagent key",
      sessionKey: "agent:main:subagent:orphan",
      entry: { sessionId: "orphan", updatedAt: 1 },
      expected: "delegated",
      admissionClass: "ordinary",
    },
    {
      name: "ACP role-only envelope",
      sessionKey: "agent:main:acp:role",
      entry: { sessionId: "acp-role", updatedAt: 1, subagentRole: "leaf" },
      expected: "delegated",
      admissionClass: "ordinary",
    },
    {
      name: "ACP control-scope envelope",
      sessionKey: "agent:main:acp:scope",
      entry: { sessionId: "acp-scope", updatedAt: 1, subagentControlScope: "none" },
      expected: "delegated",
      admissionClass: "ordinary",
    },
    {
      name: "activated ordinary handle",
      sessionKey: promotedKey,
      entry: delegatedEntry(promotedKey),
      profileId: "human",
      expected: "ordinary",
    },
    {
      name: "bare ACP session",
      sessionKey: "agent:main:acp:bare",
      entry: { sessionId: "bare", updatedAt: 1 },
      expected: "ordinary",
    },
    {
      name: "spawned child",
      sessionKey: "agent:main:subagent:child",
      entry: {
        sessionId: "child",
        updatedAt: 1,
        spawnedBy: "agent:main:main",
        spawnDepth: 1,
      },
      expected: "delegated",
    },
    {
      name: "plain dashboard session",
      sessionKey: "agent:main:dashboard:plain",
      entry: { sessionId: "dash", updatedAt: 1 },
      expected: "ordinary",
    },
  ];

  it.each(cases)("$name stamps $expected on the transcript and on live chat events", (row) => {
    const settings = captureAdmittedChatSendSessionSettings({
      commit: true,
      entry: row.entry,
      expectedPermissionMode: undefined,
      expectedToolOverrides: undefined,
      sessionKey: row.sessionKey,
      humanProfileId: row.profileId,
      assertCurrent: vi.fn(),
    });
    if (row.admissionClass) {
      expect(settings?.effectiveAdmission?.effectiveClass).toBe(row.admissionClass);
    }
    const authorityClass = typedTurnAuthorityClass(typed, settings);
    expect(authorityClass).toBe(row.expected);
    const runId = `authority-${row.entry.sessionId}`;
    registerAgentRunContext(runId, { sessionKey: row.sessionKey, authorityClass });
    try {
      expect(
        stampChatEventAuthorityClass({
          runId,
          sessionKey: row.sessionKey,
          state: "final",
        }),
      ).toMatchObject({ authorityClass });
    } finally {
      clearAgentRunContext(runId);
    }
  });
});
