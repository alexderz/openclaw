import { readAcpSessionMetaForEntry } from "../../acp/runtime/session-meta-readonly.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionEffectiveAdmission } from "../../sessions/session-promotion-state.js";
import { isOrdinarySessionEffectiveAdmission } from "../session-effective-admission.js";
import { isSubagentSessionFromEntry } from "../subagents/spawn/subagent-depth-policy.js";

/** An ordinary admitted run never sends with the delegated subagent requester envelope. */
export function isSessionsSendRequesterSubagent(params: {
  cfg: OpenClawConfig;
  requesterSession: { canonicalKey: string; agentId?: string };
  requesterSessionEntry: SessionEntry | undefined;
  sessionEffectiveAdmission?: SessionEffectiveAdmission;
  agentSessionId?: string;
}): boolean {
  const { cfg, requesterSession, requesterSessionEntry } = params;
  return (
    !isOrdinarySessionEffectiveAdmission(
      params.sessionEffectiveAdmission,
      params.agentSessionId ?? requesterSessionEntry?.sessionId,
    ) &&
    isSubagentSessionFromEntry(
      requesterSession.canonicalKey,
      requesterSessionEntry,
      readAcpSessionMetaForEntry({
        sessionKey: requesterSession.canonicalKey,
        agentId: requesterSession.agentId,
        cfg,
        entry: requesterSessionEntry,
      }),
    )
  );
}
