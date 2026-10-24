import type { SessionCapabilityEntry } from "../../agents/subagents/spawn/subagent-session-store.js";
import {
  normalizeSessionToolOverrides,
  sessionToolOverridesEqual,
} from "../../config/sessions/session-tool-overrides.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  captureSessionEffectiveAdmission,
  type SessionEffectiveAdmission,
} from "../../sessions/session-promotion-state.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";

export const SESSION_SETTINGS_CHANGED_ERROR_REASON = "session-settings-changed";
type AdmittedChatSendSessionSettings =
  | Readonly<
      Pick<SessionEntry, "permissionMode" | "toolOverrides"> & {
        effectiveAdmission?: SessionEffectiveAdmission;
      }
    >
  | undefined;

/**
 * Envelope facts from the admitted row. Keyed by the settings object both the run context and
 * the user-turn recorder classify, so a later edit of the live row cannot split the stamps.
 */
const admittedChatTurnEnvelopes = new WeakMap<
  object,
  { sessionKey: string; entry?: SessionCapabilityEntry }
>();

function rememberAdmittedChatTurnEnvelope(
  settings: object,
  sessionKey: string,
  entry: SessionEntry | undefined,
): void {
  admittedChatTurnEnvelopes.set(settings, {
    sessionKey,
    ...(entry
      ? {
          entry: {
            spawnDepth: entry.spawnDepth,
            subagentRole: entry.subagentRole,
            subagentControlScope: entry.subagentControlScope,
            spawnedBy: entry.spawnedBy,
          },
        }
      : {}),
  });
}

/** Key and sub-agent envelope captured with this admitted settings object, if it has one. */
export function readAdmittedChatTurnEnvelope(
  settings: object | null | undefined,
): { sessionKey: string; entry?: SessionCapabilityEntry } | undefined {
  return settings ? admittedChatTurnEnvelopes.get(settings) : undefined;
}

export function captureAdmittedChatSendSessionSettings(params: {
  commit: boolean;
  sessionKey?: string;
  humanProfileId?: string;
  /** Identity the request was prepared under; a later handoff never reclassifies it. */
  admittedIdentity?: { sessionId?: string; lifecycleRevision?: string };
  assertCurrent?: () => void;
  entry: SessionEntry | undefined;
  expectedPermissionMode: NormalizedChatSendRequest["p"]["expectedPermissionMode"];
  expectedToolOverrides: NormalizedChatSendRequest["p"]["expectedToolOverrides"];
}): AdmittedChatSendSessionSettings {
  const { entry, expectedPermissionMode, expectedToolOverrides } = params;
  if (
    (expectedPermissionMode !== undefined &&
      (entry?.permissionMode ?? null) !== expectedPermissionMode) ||
    (expectedToolOverrides !== undefined &&
      !sessionToolOverridesEqual(entry?.toolOverrides, expectedToolOverrides))
  ) {
    throw new Error(SESSION_SETTINGS_CHANGED_ERROR_REASON);
  }
  if (!params.commit) {
    return undefined;
  }
  const settings = Object.freeze({
    ...(entry && params.sessionKey
      ? {
          effectiveAdmission: captureSessionEffectiveAdmission({
            entry,
            sessionKey: params.sessionKey,
            humanProfileId: params.humanProfileId,
            ...(params.admittedIdentity ? { admittedIdentity: params.admittedIdentity } : {}),
            assertCurrent: params.assertCurrent,
            policyCeiling: {},
          }),
        }
      : {}),
    permissionMode: entry?.permissionMode,
    toolOverrides: normalizeSessionToolOverrides(entry?.toolOverrides),
  });
  if (params.sessionKey) {
    rememberAdmittedChatTurnEnvelope(settings, params.sessionKey, entry);
  }
  return settings;
}
