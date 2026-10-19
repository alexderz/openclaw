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
  return Object.freeze({
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
}
