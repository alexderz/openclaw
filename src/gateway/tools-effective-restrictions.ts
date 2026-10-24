import type { ToolsEffectiveRestrictionSummary } from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";

const RESTRICTION_INDEX_LIMIT = 512;

type IndexedRestrictions = {
  sessionId?: string;
  lifecycleRevision?: string;
  configKey: string;
  summary: ToolsEffectiveRestrictionSummary;
};

/**
 * Latest `tools.effective` restriction summary per session, so synchronous session rows can show
 * real values without rebuilding the tool inventory. A row only reuses a summary computed for the
 * same session id, lifecycle revision and runtime config; anything else is "not evaluated".
 */
const restrictionIndex = new Map<string, IndexedRestrictions>();

export function recordToolsEffectiveRestrictions(params: {
  sessionKey: string;
  sessionId?: string;
  lifecycleRevision?: string;
  configKey: string;
  summary: ToolsEffectiveRestrictionSummary | undefined;
}): void {
  if (!params.summary) {
    return;
  }
  const previous = restrictionIndex.get(params.sessionKey);
  if (previous && previous.summary.evaluatedAt > params.summary.evaluatedAt) {
    return;
  }
  restrictionIndex.delete(params.sessionKey);
  restrictionIndex.set(params.sessionKey, {
    sessionId: params.sessionId,
    lifecycleRevision: params.lifecycleRevision,
    configKey: params.configKey,
    summary: params.summary,
  });
  pruneMapToMaxSize(restrictionIndex, RESTRICTION_INDEX_LIMIT);
}

export function peekToolsEffectiveRestrictions(params: {
  sessionKey: string;
  sessionId?: string;
  lifecycleRevision?: string;
  configKey: string;
}): ToolsEffectiveRestrictionSummary | undefined {
  const indexed = restrictionIndex.get(params.sessionKey);
  return indexed &&
    indexed.sessionId === params.sessionId &&
    indexed.lifecycleRevision === params.lifecycleRevision &&
    indexed.configKey === params.configKey
    ? indexed.summary
    : undefined;
}

export const testing = {
  resetToolsEffectiveRestrictionsForTest() {
    restrictionIndex.clear();
  },
} as const;
