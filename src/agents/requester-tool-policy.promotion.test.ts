import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { captureSessionEffectiveAdmission } from "../sessions/session-promotion-state.js";
import { captureSessionEffectiveAdmissionForTest } from "../sessions/session-promotion-state.test-support.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { resolveRequesterToolPolicies } from "./requester-tool-policy.js";

const key = "agent:main:dashboard:visible-child";
const entry: SessionEntry = {
  sessionId: "session",
  updatedAt: 1,
  spawnedBy: "agent:main:main",
  parentSessionKey: "agent:main:main",
  spawnDepth: 2,
  inheritedToolPolicyVersion: 1,
  inheritedToolAllow: ["read"],
  lifecycleRevision: "after",
};
const store = { [key]: entry };
const ordinary = captureSessionEffectiveAdmissionForTest({
  sessionKey: key,
  sessionId: "session",
  lifecycleRevision: "after",
  effectiveClass: "ordinary",
});
const params = { sessionKey: key, preparedSessionCapabilityStore: store };
describe("immutable promotion requester policy", () => {
  it("shares ordinary sessions_send eligibility with the conversation policy pipeline while retaining config deny", () => {
    const config = { tools: { allow: ["read", "sessions_send"], deny: ["exec"] } };
    const profile = resolveConversationCapabilityProfile({
      ...params,
      config,
      sessionId: "session",
      sessionEffectiveAdmission: ordinary,
    });
    expect(isConversationToolAllowed(profile, "sessions_send")).toBe(true);
    expect(isConversationToolAllowed(profile, "exec")).toBe(false);
    const oldProfile = resolveConversationCapabilityProfile({
      ...params,
      config,
      sessionId: "session",
    });
    expect(isConversationToolAllowed(oldProfile, "sessions_send")).toBe(false);
  });
  it("retains the immutable snapshot through prepared authority construction", () => {
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "human",
      scopes: [],
      assertCurrent() {},
      sessionEffectiveAdmission: ordinary,
    });
    expect(authority.sessionEffectiveAdmission).toBe(ordinary);
  });
  it("uses the ordinary config projection only for a captured ordinary admission", () => {
    const result = resolveRequesterToolPolicies({ ...params, sessionEffectiveAdmission: ordinary });
    expect(result.delegated).toBe(false);
    expect(result.requesterPolicySource).toBe("current-request");
    expect(result.inheritedToolPolicy).toBeUndefined();
    expect(result.subagentPolicy).toBeUndefined();
    expect(entry.inheritedToolAllow).toEqual(["read"]);
  });
  it("keeps old, missing, queued and recovered snapshots delegated regardless of the live row", () => {
    for (const snapshot of [
      undefined,
      captureSessionEffectiveAdmissionForTest({
        sessionKey: key,
        sessionId: "session",
        lifecycleRevision: "after",
        effectiveClass: "delegated",
      }),
    ]) {
      const result = resolveRequesterToolPolicies({
        ...params,
        sessionEffectiveAdmission: snapshot,
      });
      expect(result.delegated).toBe(true);
      expect(result.inheritedToolPolicy).toEqual({ allow: ["read"] });
    }
  });
  it("does not apply an ordinary snapshot to a different session incarnation", () => {
    const result = resolveRequesterToolPolicies({
      ...params,
      sessionEffectiveAdmission: { ...ordinary, sessionId: "different" },
    });
    expect(result.delegated).toBe(true);
  });
  it("never lifts delegation for a structurally equal handle the owner did not mint", () => {
    for (const forged of [{ ...ordinary }, structuredClone(ordinary)]) {
      expect(forged).toEqual(ordinary);
      const result = resolveRequesterToolPolicies({ ...params, sessionEffectiveAdmission: forged });
      expect(result.delegated).toBe(true);
      expect(result.inheritedToolPolicy).toEqual({ allow: ["read"] });
    }
  });
  it("does not lift a key-shaped subagent envelope for a never-promoted row", () => {
    const subagentKey = "agent:main:subagent:legacy-child";
    // Legacy or ACP-owned delegated rows can lack spawn fields; capture reports display-only ordinary.
    const legacy: SessionEntry = { sessionId: "legacy", updatedAt: 1 };
    const display = captureSessionEffectiveAdmission({
      entry: legacy,
      sessionKey: subagentKey,
      humanProfileId: "human",
      assertCurrent() {},
      policyCeiling: {},
    });
    expect(display.effectiveClass).toBe("ordinary");
    const config = { tools: { subagents: { tools: { deny: ["sessions_send"] } } } };
    const lifted = resolveRequesterToolPolicies({
      config,
      sessionKey: subagentKey,
      sessionId: "legacy",
      preparedSessionCapabilityStore: { [subagentKey]: legacy },
      sessionEffectiveAdmission: display,
    });
    const baseline = resolveRequesterToolPolicies({
      config,
      sessionKey: subagentKey,
      sessionId: "legacy",
      preparedSessionCapabilityStore: { [subagentKey]: legacy },
    });
    expect(lifted.subagentPolicy).toEqual(baseline.subagentPolicy);
    expect(lifted.subagentPolicy).toBeDefined();
  });
});
