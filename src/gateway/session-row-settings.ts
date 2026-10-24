import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionRow } from "../../packages/gateway-protocol/src/index.js";
import { resolveModelFallbackAvailability } from "../agents/agent-scope.js";
import { resolveSessionAuthProfileOverrideSource } from "../config/sessions/auth-profile-override-provenance.js";
import { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasPersonalAuthProfilePrefix } from "../state/user-model-account-id.js";

/**
 * The fallback ladder a fresh run of this session would use, resolved like the run path does.
 * A parent-inherited override carries no auto-fallback provenance of its own.
 */
export function projectSessionModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId: string;
  key: string;
  entry: SessionEntry | undefined;
  overrideInheritedFromParent: boolean;
}): SessionRow["modelFallbacks"] {
  const { entry } = params;
  const hasStoredOverride =
    entry?.modelOverrideSource !== "default" &&
    Boolean(entry?.modelOverride || entry?.providerOverride);
  const ownOverride = hasStoredOverride && !params.overrideInheritedFromParent;
  const availability = resolveModelFallbackAvailability({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.key,
    hasSessionModelOverride: hasStoredOverride,
    modelOverrideSource:
      ownOverride && entry?.modelOverrideSource !== "default"
        ? entry?.modelOverrideSource
        : undefined,
    hasAutoFallbackProvenance: ownOverride && hasSessionAutoModelFallbackProvenance(entry),
    modelSelectionLocked: entry?.modelSelectionLocked,
    subagentSpawnLineage: (entry?.spawnDepth ?? 0) > 0,
  });
  switch (availability.kind) {
    case "active":
      return { state: "active", models: availability.models };
    case "none_configured":
      return { state: "none" };
    case "disabled_by_model_override":
      return { state: "disabled-by-model-override" };
    case "disabled_by_model_selection_lock":
      return { state: "disabled-by-model-lock" };
  }
}

/**
 * Display label of the session's pinned auth profile. Personal ids are minted as
 * `personal:<owner>:<credential>`. The locator grammar only accepts a UUID or gateway-owner
 * segment, but any case-sensitive `personal:` id can still carry an owner and a credential
 * locator, including a legacy owner segment. Those project as kind personal with no locator.
 * A different case, such as `Personal:`, stays a named label.
 */
export function projectSessionAuthProfile(
  entry: SessionEntry | undefined,
): SessionRow["authProfile"] {
  const profileId = entry?.authProfileOverride?.trim();
  if (!profileId) {
    return undefined;
  }
  const source = resolveSessionAuthProfileOverrideSource(entry);
  return {
    ...(hasPersonalAuthProfilePrefix(profileId)
      ? { kind: "personal" as const }
      : { kind: "named" as const, label: profileId }),
    ...(source ? { source } : {}),
  };
}

/** Session settings facts for one row: usage counters, exec host, fallbacks and auth label. */
export function projectSessionRowSettings(input: {
  cfg: OpenClawConfig;
  key: string;
  agentId: string;
  entry: SessionEntry | undefined;
  selectedModel: { storedOverrideSource?: string | null };
}): Pick<
  SessionRow,
  | "execHost"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "compactionCount"
  | "modelFallbacks"
  | "authProfile"
> {
  const { entry } = input;
  return {
    execHost: normalizeOptionalString(entry?.execHost),
    cacheReadTokens: asNonNegativeFiniteNumber(entry?.cacheRead),
    cacheWriteTokens: asNonNegativeFiniteNumber(entry?.cacheWrite),
    compactionCount: asNonNegativeFiniteNumber(entry?.compactionCount),
    modelFallbacks: entry
      ? projectSessionModelFallbacks({
          cfg: input.cfg,
          agentId: input.agentId,
          key: input.key,
          entry,
          overrideInheritedFromParent: input.selectedModel.storedOverrideSource === "parent",
        })
      : undefined,
    authProfile: projectSessionAuthProfile(entry),
  };
}
