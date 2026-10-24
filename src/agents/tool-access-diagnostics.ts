import type {
  ToolAccessDiagnostics,
  ToolRestrictionOrigin,
  ToolsEffectiveRestrictionSummary,
} from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEffectiveToolPolicy } from "./agent-tools.policy.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { resolveConfiguredModelRef } from "./model-selection-shared.js";
import { listCoreToolSections } from "./tool-catalog.js";
import { createToolPolicyMatcher } from "./tool-policy-match.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
  type ToolPolicyFilterEvent,
} from "./tool-policy-pipeline.js";
import {
  mergeAlsoAllowPolicy,
  normalizeToolPolicyName,
  resolveToolProfilePolicy,
} from "./tool-policy.js";

export type { ToolAccessDiagnostics };
type ToolAccess = ToolAccessDiagnostics["tools"][number];
type Reason = ToolAccess["reasons"][number];

/** Layers an ordinary session of the same agent does not have. */
const DELEGATION_ORIGINS: ReadonlySet<ToolRestrictionOrigin> = new Set([
  "inherited-limit",
  "subagent-layer",
]);

/**
 * Summary-first view of what delegation removes. A tool counts only when every restriction on it
 * is a delegation layer: anything also blocked by agent policy, sandbox or role would be missing
 * from an ordinary session of the same agent as well.
 */
export function summarizeToolRestrictions(params: {
  toolAccess: ToolAccessDiagnostics;
  /** Tools the session actually built; a policy cannot take away a tool that never existed. */
  constructedToolIds?: ReadonlySet<string>;
  evaluatedClass: ToolsEffectiveRestrictionSummary["evaluatedClass"];
  evaluatedAt: number;
}): ToolsEffectiveRestrictionSummary {
  const limitedTools = params.toolAccess.tools
    .flatMap((tool) => {
      if (
        tool.status !== "excluded" ||
        tool.reasons.length === 0 ||
        (params.constructedToolIds && !params.constructedToolIds.has(tool.id))
      ) {
        return [];
      }
      const origins = [...new Set(tool.reasons.map((reason) => reason.origin ?? "other"))];
      return origins.every((origin) => DELEGATION_ORIGINS.has(origin))
        ? [{ id: tool.id, origins: origins.toSorted() }]
        : [];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const send =
    params.toolAccess.checked === "live-session"
      ? params.toolAccess.tools.find((tool) => tool.id === "sessions_send")
      : undefined;
  return {
    evaluatedClass: params.evaluatedClass,
    limitedTools,
    sessionsSend:
      send?.status === "available"
        ? "allowed"
        : send?.status === "excluded" || send?.status === "unavailable"
          ? "denied"
          : "unknown",
    evaluatedAt: params.evaluatedAt,
  };
}

/** Observe the same expanded policies that filter tools, including later blockers. */
export function createToolAccessDiagnostics(params: {
  profiles: ToolAccessDiagnostics["profiles"];
  toolNames?: readonly string[];
}) {
  const candidates = new Map<string, { reasons: Reason[]; alsoAllowPath?: string }>();
  const constructed = new Set<string>();
  const include = (name: string) => {
    const id = normalizeToolPolicyName(name);
    if (!candidates.has(id)) {
      candidates.set(id, { reasons: [] });
    }
  };
  for (const name of params.toolNames ??
    listCoreToolSections().flatMap((section) => section.tools.map((tool) => tool.id))) {
    include(name);
  }
  const onFilter = (event: ToolPolicyFilterEvent<{ name: string }>) => {
    for (const tool of event.before) {
      include(tool.name);
      constructed.add(normalizeToolPolicyName(tool.name));
    }
    const permits = createToolPolicyMatcher(event.policy);
    const notDenied = createToolPolicyMatcher({ deny: event.policy.deny });
    const source = event.step.source;
    for (const [id, candidate] of candidates) {
      if (permits(id)) {
        continue;
      }
      const denied = !notDenied(id);
      const kind =
        source?.kind === "profile"
          ? "profile"
          : source?.kind === "session" || source?.kind === "runtime"
            ? source.kind
            : denied
              ? "deny"
              : "allowlist";
      const path = source?.path
        ? `${source.path}${source.kind === "config" ? (denied ? ".deny" : ".allow") : ""}`
        : undefined;
      candidate.reasons.push({
        kind,
        label:
          kind === "profile"
            ? `${source?.profile ?? "Selected"} profile`
            : `${denied ? "Denied by" : "Not included in"} ${path ?? event.step.label}`,
        ...(path ? { source: path } : {}),
        ...(source?.profile ? { profile: source.profile } : {}),
        origin:
          event.step.origin ??
          (source?.kind === "profile" || source?.kind === "config" ? "agent-policy" : "other"),
      });
      candidate.alsoAllowPath =
        candidate.reasons.length === 1 && kind === "profile" ? source?.alsoAllowPath : undefined;
    }
  };
  return {
    onFilter,
    /** Tools that entered at least one observed policy layer. */
    constructedToolIds: (): ReadonlySet<string> => new Set(constructed),
    finish(availableToolNames?: readonly string[]): ToolAccessDiagnostics {
      const available =
        availableToolNames && new Set(availableToolNames.map(normalizeToolPolicyName));
      available?.forEach(include);
      return {
        checked: available ? "live-session" : "local-config",
        profiles: params.profiles,
        tools: [...candidates].map(([id, candidate]): ToolAccess => {
          // Final presence wins: host-owned tools can intentionally survive policy filtering.
          if (available?.has(id)) {
            return { id, status: "available", reasons: [] };
          }
          if (candidate.reasons.length > 0) {
            const tool: ToolAccess = {
              id,
              status: "excluded",
              reasons: candidate.reasons,
            };
            if (candidate.alsoAllowPath && (!available || constructed.has(id))) {
              tool.alsoAllowPath = candidate.alsoAllowPath;
            }
            return tool;
          }
          return {
            id,
            status: available ? "unavailable" : "allowed",
            reasons: available
              ? [{ kind: "runtime", label: "Not included in the session preview", origin: "other" }]
              : [],
          };
        }),
      };
    },
  };
}

/** Local policy can prove exclusion; it cannot prove a live tool was constructed. */
export function resolveConfiguredToolAccess(params: {
  config: OpenClawConfig;
  agentId: string;
  toolNames?: readonly string[];
  modelProvider?: string;
  modelId?: string;
}): ToolAccessDiagnostics {
  const model =
    params.modelProvider && params.modelId
      ? undefined
      : resolveConfiguredModelRef({
          cfg: params.config,
          agentId: params.agentId,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
        });
  const policy = resolveEffectiveToolPolicy({
    config: params.config,
    agentId: params.agentId,
    modelProvider: params.modelProvider ?? model?.provider,
    modelId: params.modelId ?? model?.model,
  });
  const toolNames = params.toolNames ?? ["exec", "process"];
  const diagnostics = createToolAccessDiagnostics({ profiles: policy.profiles, toolNames });
  applyToolPolicyPipeline({
    tools: toolNames.map((name) => ({ name })),
    toolMeta: () => undefined,
    warn: () => undefined,
    steps: buildDefaultToolPolicyPipelineSteps({
      ...policy,
      profilePolicy: mergeAlsoAllowPolicy(
        resolveToolProfilePolicy(policy.profile),
        policy.profileAlsoAllow,
      ),
      providerProfilePolicy: mergeAlsoAllowPolicy(
        resolveToolProfilePolicy(policy.providerProfile),
        policy.providerProfileAlsoAllow,
      ),
    }),
    onFilter: diagnostics.onFilter,
  });
  return diagnostics.finish();
}
