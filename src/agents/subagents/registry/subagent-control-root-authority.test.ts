import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  ensureSubagentControllerOwnsRun,
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

  it("still authorizes that edge when the caller did not supply root facts", () => {
    expect(
      ensureSubagentControllerOwnsRun({
        cfg,
        controller: { controllerSessionKey: parent, controllerAgentId: "main" },
        entry: spawner,
      }),
    ).toBeUndefined();
    expect(isSubagentRunVisibleToSession(spawner, parent, "main", cfg)).toBe(true);
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
        { proved: true, missing: false, promotedFrom: undefined },
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
});
