import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { isAdminPromotionScopes } from "../sessions/session-promotion-state.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { GatewayClient } from "./server-methods/types.js";

type PromotionClient = GatewayClient | null | undefined;

/**
 * Connection-shape half of the human predicate: an authenticated operator on a host-attested
 * Control UI ingress, with no model, tool, runtime, automation, approval, plugin or synthetic
 * marker. The viewer projection uses it as is; request ingress adds liveness and pinning below.
 */
export function isControlUiHumanClient(client: PromotionClient): boolean {
  const internal = client?.internal;
  return Boolean(
    client &&
    !client.invalidated &&
    client.connect.role === "operator" &&
    internal?.authenticatedOperator === true &&
    internal.authenticatedControlUi === true &&
    client.authenticatedUserProfile?.profileId &&
    !client.authenticatedGitHubIdentitySync &&
    !internal.syntheticClient &&
    !internal.agentRuntimeIdentity &&
    !internal.agentToolCaller &&
    !internal.operatorRunAuthority &&
    !internal.cronRunContinuation &&
    !internal.approvalRuntime &&
    !internal.pluginRuntimeOwnerId &&
    !internal.nodeInvokeApprovalSessionKey &&
    !getGatewayToolCallerIdentity() &&
    roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.sessions.write"],
      allowedScopes: client.connect.scopes ?? [],
    }),
  );
}

/**
 * The live admin path: the connection-time, host-attested Control UI admin flag
 * (connect-session.ts) together with operator.admin in the current scopes. Scopes alone, a
 * wire client id or a trusted hint never qualify.
 */
export function isControlUiAdminClient(client: PromotionClient): boolean {
  return (
    isControlUiHumanClient(client) &&
    client?.internal?.controlUiAdmin === true &&
    isAdminPromotionScopes(client.connect.scopes ?? [])
  );
}
