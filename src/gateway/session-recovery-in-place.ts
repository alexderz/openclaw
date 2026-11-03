import { randomUUID } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import { resolveResetPreservedSelection } from "../config/sessions/reset-preserved-selection.js";
import { preserveSessionLineage } from "../config/sessions/session-entry-lineage.js";
import { preserveCreationStamp } from "../config/sessions/session-entry-provenance.js";
import { SESSION_TOTAL_TOKENS_VERSION, type InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";

/**
 * Main is the agent's standing conversation: restart recovery must keep it under its own
 * key instead of archiving it behind a dashboard successor. Covers the default
 * `agent:<id>:main` alias and the configured `session.mainKey`/global scope identity.
 */
export function isMainSessionRecoveryTarget(
  cfg: OpenClawConfig,
  target: { agentId: string; canonicalKey: string },
): boolean {
  const key = normalizeLowercaseStringOrEmpty(target.canonicalKey);
  if (!key) {
    return false;
  }
  const candidates = [
    resolveCanonicalMainSessionKey({
      agentId: target.agentId,
      mainKey: cfg.session?.mainKey,
      sessionScope: cfg.session?.scope,
    }),
    buildAgentMainSessionKey({ agentId: target.agentId }),
  ];
  return candidates.some((candidate) => normalizeLowercaseStringOrEmpty(candidate) === key);
}

/**
 * Build the row Main continues on after an in-place recovery roll. The carry-forward set
 * mirrors sessions.reset (session-reset-service.ts) so Main keeps its identity, routing and
 * user choices; recovery adds the new session id and keeps its harness/model lock like the
 * successor row it replaces. CLI provider bindings are dropped so the next turn reseeds from
 * the cloned transcript, and archive/recovery custody is never carried.
 */
export function buildInPlaceRecoveryEntry(
  source: InternalSessionEntry,
  sessionId: string,
): InternalSessionEntry & { sessionId: string } {
  const now = Date.now();
  return {
    sessionId,
    previousSessionId: source.sessionId,
    lifecycleRevision: randomUUID(),
    updatedAt: now,
    sessionStartedAt: now,
    systemSent: false,
    abortedLastRun: false,
    contextWindow: source.contextWindow,
    thinkingLevel: source.thinkingLevel,
    fastMode: source.fastMode,
    toolOverrides: source.toolOverrides,
    verboseLevel: source.verboseLevel,
    traceLevel: source.traceLevel,
    reasoningLevel: source.reasoningLevel,
    elevatedLevel: source.elevatedLevel,
    ttsAuto: source.ttsAuto,
    execHost: source.execHost,
    execNode: source.execNode,
    execCwd: source.execCwd,
    responseUsage: source.responseUsage,
    pinnedAt: source.pinnedAt,
    ...resolveResetPreservedSelection({ entry: source }),
    groupActivation: source.groupActivation,
    groupActivationNeedsSystemIntro: source.groupActivationNeedsSystemIntro,
    chatType: source.chatType,
    compactionCount: 0,
    sendPolicy: source.sendPolicy,
    queueMode: source.queueMode,
    queueDebounceMs: source.queueDebounceMs,
    queueCap: source.queueCap,
    queueDrop: source.queueDrop,
    ...preserveSessionLineage(source),
    completionOwnerSessionKey: source.completionOwnerSessionKey,
    spawnedWorkspaceDir: source.spawnedWorkspaceDir,
    spawnedCwd: source.spawnedCwd,
    sessionRoot: source.sessionRoot,
    permissionMode: source.permissionMode,
    sandboxMode: source.sandboxMode,
    worktree: source.worktree,
    repositoryWorkspaceId: source.repositoryWorkspaceId,
    ...preserveCreationStamp({}, source),
    projectId: source.projectId,
    label: source.label,
    autoLabel: source.autoLabel,
    icon: source.icon,
    category: source.category,
    boardFace: source.boardFace,
    boardPresentation: source.boardPresentation,
    visibility: source.visibility,
    displayName: source.displayName,
    delivery: source.delivery,
    pendingDeliveryNotice: source.pendingDeliveryNotice,
    groupId: source.groupId,
    subject: source.subject,
    groupChannel: source.groupChannel,
    space: source.space,
    pluginOwnerId: source.pluginOwnerId,
    ...(source.agentHarnessId ? { agentHarnessId: source.agentHarnessId } : {}),
    ...(source.modelSelectionLocked === true ? { modelSelectionLocked: true as const } : {}),
    usageFamilyKey: source.usageFamilyKey,
    usageFamilySessionIds: source.usageFamilySessionIds,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalTokensFresh: true,
    totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
  };
}
