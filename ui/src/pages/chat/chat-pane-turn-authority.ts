import type { GatewaySessionRow, ToolsEffectiveResult } from "../../api/types.ts";
import { summarizeSessionPermissions } from "../../components/session-settings/session-settings-permissions.ts";
import { formatPermissionsHeadline } from "../../components/session-settings/session-settings-sections.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import type { TurnAuthorityHost } from "./components/chat-turn-authority-marker.ts";

type ToolsClient = {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

/**
 * The pane's side of the delegated-turn marker. Every popover open reads `tools.effective` once,
 * as the sheet's Permissions section does, so the headline is the sheet's own words for the
 * session as it is now. A missing row or connection reads as "not checked", never a guess.
 */
export function createTurnAuthorityHost(params: {
  readRow: () => GatewaySessionRow | undefined;
  /** The Gateway client while connected, else null. */
  readClient: () => ToolsClient | null;
  openPermissions: (returnFocus: HTMLElement) => boolean;
}): TurnAuthorityHost {
  return {
    async readPermissionsHeadline() {
      const row = params.readRow();
      const client = params.readClient();
      const agentId = row ? (row.agentId ?? parseAgentSessionKey(row.key)?.agentId) : undefined;
      const result =
        row && client
          ? await client.request<ToolsEffectiveResult>("tools.effective", {
              sessionKey: row.key,
              ...(agentId ? { agentId } : {}),
            })
          : null;
      return formatPermissionsHeadline(summarizeSessionPermissions(row?.promotion, result));
    },
    openPermissions: params.openPermissions,
  };
}
