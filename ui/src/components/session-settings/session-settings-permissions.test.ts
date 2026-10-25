import { describe, expect, it } from "vitest";
import type { SessionCapabilityStatus, ToolsEffectiveResult } from "../../api/types.ts";
import { promotionProjection } from "../../lib/sessions/session-promotion.test-support.ts";
import { summarizeSessionPermissions } from "./session-settings-permissions.ts";

const STANDARD = [
  "agents_list",
  "automations",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "gateway",
  "message",
  "openclaw",
  "progress_card",
  "session_status",
  "sessions_send",
];

function toolsResult(
  restrictions: ToolsEffectiveResult["restrictions"],
  tools = ["read", "write", "exec"],
): ToolsEffectiveResult {
  return {
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in",
        source: "core",
        tools: tools.map((id) => ({
          id,
          label: id,
          description: "",
          rawDescription: "",
          source: "core",
        })),
      },
    ],
    restrictions,
  };
}

const delegated = promotionProjection("authorized-none");
const ordinary: SessionCapabilityStatus = {
  ...delegated,
  historicalOrigin: "ordinary",
  effectiveClass: "ordinary",
  classScope: "all-turns",
};

describe("summarizeSessionPermissions", () => {
  it("folds the standard sub-agent denials and counts only the limits beyond them", () => {
    const summary = summarizeSessionPermissions(
      delegated,
      toolsResult({
        evaluatedClass: "delegated",
        limitedTools: [
          ...STANDARD.map((id) => ({ id, origins: ["subagent-layer" as const] })),
          { id: "browser", origins: ["inherited-limit"] },
          { id: "sessions_spawn", origins: ["subagent-layer"] },
          // Several origins: listed once, under the first plain-word heading.
          { id: "web_fetch", origins: ["inherited-limit", "subagent-layer"] },
        ],
        sessionsSend: "denied",
        evaluatedAt: 1,
      }),
    );
    expect(summary).toEqual({
      kind: "limited",
      evaluatedClass: "delegated",
      standard: STANDARD,
      groups: [
        { origin: "inherited-limit", tools: ["browser", "web_fetch"] },
        { origin: "subagent-layer", tools: ["sessions_spawn"] },
      ],
      extraCount: 3,
      sessionsSend: "denied",
      toolCount: 3,
      viewerDiffers: false,
    });
  });

  it("keeps a standard tool as an extra limit when only the parent took it away", () => {
    const summary = summarizeSessionPermissions(
      delegated,
      toolsResult({
        evaluatedClass: "delegated",
        limitedTools: [{ id: "message", origins: ["inherited-limit"] }],
        sessionsSend: "allowed",
        evaluatedAt: 1,
      }),
    );
    expect(summary).toMatchObject({
      kind: "limited",
      standard: [],
      groups: [{ origin: "inherited-limit", tools: ["message"] }],
      extraCount: 1,
    });
  });

  it("reports full permissions when nothing is limited compared with an ordinary session", () => {
    expect(
      summarizeSessionPermissions(
        ordinary,
        toolsResult({
          evaluatedClass: "ordinary",
          limitedTools: [],
          sessionsSend: "allowed",
          evaluatedAt: 1,
        }),
      ),
    ).toEqual({ kind: "full", toolCount: 3, viewerDiffers: false });
  });

  it("is not full permissions while session messaging is denied or unchecked", () => {
    for (const sessionsSend of ["denied", "unknown"] as const) {
      expect(
        summarizeSessionPermissions(
          ordinary,
          toolsResult({
            evaluatedClass: "ordinary",
            limitedTools: [],
            sessionsSend,
            evaluatedAt: 1,
          }),
        ),
      ).toMatchObject({ kind: "limited", standard: [], groups: [], extraCount: 0, sessionsSend });
    }
  });

  it("says unknown, with the row's messaging state, until tools.effective has run", () => {
    expect(summarizeSessionPermissions(delegated, null)).toEqual({
      kind: "unknown",
      sessionsSend: "unknown",
    });
    // An older Gateway sends no restriction summary: still unknown, never "full".
    expect(summarizeSessionPermissions(ordinary, toolsResult(undefined))).toEqual({
      kind: "unknown",
      sessionsSend: "unknown",
    });
  });

  it("flags an evaluation made for the other class than this viewer's turns", () => {
    const summary = summarizeSessionPermissions(
      promotionProjection("promoted-requester"),
      toolsResult({
        evaluatedClass: "delegated",
        limitedTools: [{ id: "gateway", origins: ["subagent-layer"] }],
        sessionsSend: "denied",
        evaluatedAt: 1,
      }),
    );
    expect(summary).toMatchObject({ kind: "limited", viewerDiffers: true, extraCount: 0 });
  });
});
