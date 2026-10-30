/** Worker-backed proof that a detached session root is no longer a former parent's child. */
import { cloneEnvWithPlatformSemantics } from "../../../config/config-env-vars.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";

export const PROMOTED_ROOT_FORMER_PARENT_DENIED =
  "Promoted session is no longer owned by its former parent.";
export const UNPROVED_ROOT_CONTROL_DENIED =
  "Session ownership could not be proved; former-parent control is refused.";

export type ChildRootAuthorization =
  | { proved: false }
  | { proved: true; missing: true }
  | {
      proved: true;
      missing: false;
      promotedFrom: SessionEntry["promotedFrom"];
    };

type RootEdge = Pick<
  SubagentRunReadRecord,
  "requesterSessionKey" | "childSessionKey" | "childHandoff"
>;

export function isFormerParentSpawnerEdge(
  entry: Pick<SubagentRunReadRecord, "requesterSessionKey" | "childSessionKey">,
): boolean {
  return entry.requesterSessionKey.trim() !== entry.childSessionKey.trim();
}

/**
 * Deny former-parent control of a committed detached root.
 * A registry childHandoff marker stays on the existing ownership checks.
 * A missing row is proved absence, not a detached root.
 */
export function detachedRootAuthorizationError(
  entry: RootEdge,
  facts: ChildRootAuthorization,
): string | undefined {
  if (entry.childHandoff) {
    return undefined;
  }
  if (!facts.proved) {
    return UNPROVED_ROOT_CONTROL_DENIED;
  }
  if (facts.missing) {
    return undefined;
  }
  if (facts.promotedFrom !== undefined && isFormerParentSpawnerEdge(entry)) {
    return PROMOTED_ROOT_FORMER_PARENT_DENIED;
  }
  return undefined;
}

/** Read the child session row. Unknown worker outcomes stay terminal; other failures are unproved. */
export async function readChildRootAuthorization(
  cfg: OpenClawConfig,
  entry: Pick<SubagentRunReadRecord, "childSessionKey" | "childAgentId">,
  assertCurrent: () => void = () => {},
): Promise<ChildRootAuthorization> {
  const owner = resolveSubagentChildSessionOwner(entry, cfg);
  const env = cloneEnvWithPlatformSemantics(process.env);
  try {
    return await withSessionEntryReadOnlyInWorker(
      {
        storePath: owner.storePath,
        sessionKey: entry.childSessionKey,
        agentId: owner.agentId,
        env,
      },
      assertCurrent,
      async (read) => {
        if (!read.ok) {
          return { proved: false };
        }
        if (read.value === undefined) {
          return { proved: true, missing: true };
        }
        return {
          proved: true,
          missing: false,
          promotedFrom: read.value.promotedFrom,
        };
      },
    );
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return { proved: false };
  }
}
