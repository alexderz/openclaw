import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildAgentMainSessionKey } from "@openclaw/session-url-contract";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { isActivatedSessionPromotionFor } from "../../sessions/session-promotion-state.js";
import type { SessionEntry } from "./types.js";

// Pins are root-session facts; children live in their parent's tree.
// Durable dashboard sessions auto-parent to the agent main root for flow-up
// notices and sidebar threads; that lineage does not make them nested children.
// An activated promotion makes a delegated session pinnable while its spawn
// lineage (spawnedBy, parent link and sidebar nesting) stays as it is.
export function isPinnableSessionEntry(
  storeKey: string,
  entry:
    | (Pick<SessionEntry, "spawnedBy" | "parentSessionKey" | "sessionId" | "lifecycleRevision"> & {
        sessionPromotion?: unknown;
      })
    | undefined,
): boolean {
  if (isSubagentSessionKey(storeKey) || normalizeOptionalString(entry?.spawnedBy)) {
    return entry !== undefined && isActivatedSessionPromotionFor(storeKey, entry);
  }
  const parentSessionKey = normalizeOptionalString(entry?.parentSessionKey);
  if (!parentSessionKey) {
    return true;
  }
  const parsed = parseAgentSessionKey(storeKey);
  return (
    (parsed !== null &&
      parentSessionKey === buildAgentMainSessionKey({ agentId: parsed.agentId })) ||
    (entry !== undefined && isActivatedSessionPromotionFor(storeKey, entry))
  );
}
