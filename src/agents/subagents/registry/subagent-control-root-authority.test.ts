import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  ensureSubagentControllerOwnsRun,
  isSubagentRunCandidateForSession,
  isSubagentRunVisibleToSession,
} from "./subagent-control-scope.js";
import {
  PROMOTED_ROOT_FORMER_PARENT_DENIED,
  UNPROVED_ROOT_CONTROL_DENIED,
  detachedRootAuthorizationError,
  type ChildRootAuthorization,
} from "./subagent-control-root-authority.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";

const cfg = {} as OpenClawConfig;
const parent = "agent:main:main";
const child = "agent:main:subagent:child";
const promoted = {
  version: 1 as const,
  requestId: "request",
  profileId: "profile",
  at: 1,
};
const provedPromoted: ChildRootAuthorization = {
  proved: true,
  missing: false,
  promotedFrom: promoted,
  sessionId: "child-session",
  lifecycleRevision: "child-revision",
};
const provedDelegated: ChildRootAuthorization = {
  proved: true,
  missing: false,
  promotedFrom: undefined,
  sessionId: "child-session",
  lifecycleRevision: "child-revision",
};
const spawner = {
  requesterSessionKey: parent,
  childSessionKey: child,
  controllerSessionKey: parent,
  requesterAgentId: "main",
} as SubagentRunReadRecord;

describe("detached root authorization", () => {
  it("denies a proved detached spawner edge when registry handoff is absent", () => {
    expect(detachedRootAuthorizationError(spawner, provedPromoted)).toBe(
      PROMOTED_ROOT_FORMER_PARENT_DENIED,
    );
    expect(
      ensureSubagentControllerOwnsRun({
        cfg,
        controller: { controllerSessionKey: parent, controllerAgentId: "main" },
        entry: spawner,
        rootFacts: provedPromoted,
      }),
    ).toBe(PROMOTED_ROOT_FORMER_PARENT_DENIED);
    expect(isSubagentRunVisibleToSession(spawner, parent, "main", cfg, provedPromoted)).toBe(
      false,
    );
  });

  it("denies the final authorization API when root facts are omitted", () => {
    expect(
      ensureSubagentControllerOwnsRun({
        cfg,
        controller: { controllerSessionKey: parent, controllerAgentId: "main" },
        entry: spawner,
      }),
    ).toBe(UNPROVED_ROOT_CONTROL_DENIED);
    expect(isSubagentRunVisibleToSession(spawner, parent, "main", cfg)).toBe(false);
    expect(isSubagentRunCandidateForSession(spawner, parent, "main", cfg)).toBe(true);
  });

  it("fails closed when root facts are unproved", () => {
    const unproved: ChildRootAuthorization = { proved: false };
    expect(detachedRootAuthorizationError(spawner, unproved)).toBe(UNPROVED_ROOT_CONTROL_DENIED);
    expect(isSubagentRunVisibleToSession(spawner, parent, "main", cfg, unproved)).toBe(false);
    expect(
      ensureSubagentControllerOwnsRun({
        cfg,
        controller: { controllerSessionKey: parent, controllerAgentId: "main" },
        entry: spawner,
        rootFacts: unproved,
      }),
    ).toBe(UNPROVED_ROOT_CONTROL_DENIED);
  });

  it("does not treat a missing row or a same-key replacement as a detached root", () => {
    expect(detachedRootAuthorizationError(spawner, { proved: true, missing: true })).toBeUndefined();
    expect(
      detachedRootAuthorizationError(
        { ...spawner, requesterSessionKey: child, childSessionKey: child },
        provedPromoted,
      ),
    ).toBeUndefined();
    expect(
      detachedRootAuthorizationError(
        spawner,
        provedDelegated,
      ),
    ).toBeUndefined();
  });

  it("leaves the registry handoff marker on the existing ownership check", () => {
    const handedOff = {
      ...spawner,
      childHandoff: { kind: "session-promoted" as const, at: 1 },
    };
    expect(detachedRootAuthorizationError(handedOff, { proved: false })).toBeUndefined();
    expect(
      ensureSubagentControllerOwnsRun({
        cfg,
        controller: { controllerSessionKey: parent, controllerAgentId: "main" },
        entry: handedOff,
      }),
    ).toBe("This session was promoted to a standard session; its former parent no longer controls it.");
    expect(isSubagentRunVisibleToSession(handedOff, parent, "main", cfg)).toBe(false);
  });

  it("denies a promoted edge for an independent controller and a cross-agent requester", () => {
    const independent = {
      ...spawner,
      controllerSessionKey: "agent:main:dashboard:controller",
      requesterSessionKey: "agent:other:main",
    } as SubagentRunReadRecord;
    expect(detachedRootAuthorizationError(independent, provedPromoted)).toBe(
      PROMOTED_ROOT_FORMER_PARENT_DENIED,
    );
    const rawRequester = {
      ...spawner,
      requesterSessionKey: "other",
    } as SubagentRunReadRecord;
    expect(detachedRootAuthorizationError(rawRequester, provedPromoted)).toBe(
      PROMOTED_ROOT_FORMER_PARENT_DENIED,
    );
  });

  it("does not treat a self-requester record as a former-parent spawner edge", () => {
    const self = {
      ...spawner,
      requesterSessionKey: child,
      childSessionKey: child,
      controllerSessionKey: "agent:main:dashboard:controller",
    } as SubagentRunReadRecord;
    expect(detachedRootAuthorizationError(self, provedPromoted)).toBeUndefined();
    expect(
      ensureSubagentControllerOwnsRun({
        cfg,
        controller: { controllerSessionKey: parent, controllerAgentId: "main" },
        entry: self,
        rootFacts: provedPromoted,
      }),
    ).toBe("Subagents can only control runs spawned from their own session.");
  });
});
