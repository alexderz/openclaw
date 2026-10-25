import type { ToolRestrictionOrigin } from "../../../../packages/gateway-protocol/src/schema/tools-catalog.js";
import { SUBAGENT_TOOL_DENY_ALWAYS } from "../../../../src/agents/subagent-tool-deny.js";
import type { SessionCapabilityStatus, ToolsEffectiveResult } from "../../api/types.ts";

type SessionsSend = SessionCapabilityStatus["capabilities"]["sessionsSend"];

/** Heading order for the remaining limits; a tool with several origins sits under the first. */
export const RESTRICTION_ORIGIN_ORDER: readonly ToolRestrictionOrigin[] = [
  "role",
  "agent-policy",
  "inherited-limit",
  "subagent-layer",
  "sandbox",
  "other",
];

const STANDARD_SUBAGENT_LIMITS: ReadonlySet<string> = new Set(SUBAGENT_TOOL_DENY_ALWAYS);

export type PermissionLimitGroup = { origin: ToolRestrictionOrigin; tools: string[] };

export type SessionPermissionsSummary =
  /** Not evaluated: rows carry no tool data until `tools.effective` runs for the session. */
  | { kind: "unknown"; sessionsSend: SessionsSend }
  /** Nothing limited compared with an ordinary session of the same agent. */
  | { kind: "full"; toolCount: number; viewerDiffers: boolean }
  | {
      kind: "limited";
      evaluatedClass: "ordinary" | "delegated";
      /** The standard sub-agent denials folded into one line, in tool-id order. */
      standard: string[];
      /** Limits beyond the standard set, grouped by plain-word source. */
      groups: PermissionLimitGroup[];
      extraCount: number;
      sessionsSend: SessionsSend;
      toolCount: number;
      /** The evaluation ran for the other class, as for a promoted requester's own turns. */
      viewerDiffers: boolean;
    };

/** Every effective tool the session has, grouped as `tools.effective` groups them. */
export function effectiveToolGroups(result: ToolsEffectiveResult | null | undefined) {
  return (result?.groups ?? [])
    .map((group) => ({ label: group.label, tools: group.tools.map((tool) => tool.id) }))
    .filter((group) => group.tools.length > 0);
}

/**
 * Summary-first permissions: what this session lacks compared with an ordinary session of the
 * same agent. Limits every session of the agent shares are not counted (the server already
 * leaves them out of `restrictions.limitedTools`); the standard sub-agent denials fold to one line.
 */
export function summarizeSessionPermissions(
  status: SessionCapabilityStatus | undefined,
  result: ToolsEffectiveResult | null | undefined,
): SessionPermissionsSummary {
  const restrictions = result?.restrictions;
  if (!restrictions) {
    return { kind: "unknown", sessionsSend: status?.capabilities.sessionsSend ?? "unknown" };
  }
  const toolCount = effectiveToolGroups(result).reduce((sum, group) => sum + group.tools.length, 0);
  const viewerDiffers = Boolean(
    status &&
    status.effectiveClass !== "unknown" &&
    status.effectiveClass !== restrictions.evaluatedClass,
  );
  // Session messaging is reported apart from the tool list, so a denied or unchecked
  // sessions_send still keeps the headline off "Full permissions".
  if (restrictions.limitedTools.length === 0 && restrictions.sessionsSend === "allowed") {
    return { kind: "full", toolCount, viewerDiffers };
  }
  const standard: string[] = [];
  const byOrigin = new Map<ToolRestrictionOrigin, string[]>();
  for (const tool of restrictions.limitedTools) {
    if (STANDARD_SUBAGENT_LIMITS.has(tool.id) && tool.origins.includes("subagent-layer")) {
      standard.push(tool.id);
      continue;
    }
    const origin =
      RESTRICTION_ORIGIN_ORDER.find((candidate) => tool.origins.includes(candidate)) ?? "other";
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), tool.id]);
  }
  const groups = RESTRICTION_ORIGIN_ORDER.flatMap((origin) => {
    const tools = byOrigin.get(origin);
    return tools ? [{ origin, tools }] : [];
  });
  return {
    kind: "limited",
    evaluatedClass: restrictions.evaluatedClass,
    standard,
    groups,
    extraCount: groups.reduce((sum, group) => sum + group.tools.length, 0),
    sessionsSend: restrictions.sessionsSend,
    toolCount,
    viewerDiffers,
  };
}
