import type { GatewaySessionRow } from "../../api/types.ts";
import type { SidebarSessionMutationScope } from "../../components/app-sidebar-session-types.ts";
import {
  runSessionPromotion,
  sessionPromotionOutcomes,
  type PromotionKind,
  type PromotionUiState,
} from "../../components/session-promotion-request.ts";
import { ChatPaneContext } from "./chat-pane-context.ts";

export type { PromotionKind, PromotionUiState };

export abstract class ChatPaneSessionPromotion extends ChatPaneContext {
  private readonly refreshPromotionOutcome = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    // The sidebar menu or another pane may change an outcome this header shows.
    sessionPromotionOutcomes.addEventListener("change", this.refreshPromotionOutcome);
  }

  override disconnectedCallback() {
    sessionPromotionOutcomes.removeEventListener("change", this.refreshPromotionOutcome);
    super.disconnectedCallback();
  }

  protected abstract resolveHeaderSessionTitle(row: GatewaySessionRow | undefined): string;

  protected readPromotionOutcome(row: GatewaySessionRow): PromotionUiState | undefined {
    return sessionPromotionOutcomes.read(this.context.gateway, row);
  }

  protected handleSessionPromotion(kind: PromotionKind, row: GatewaySessionRow): Promise<void> {
    return runSessionPromotion(kind, row, {
      outcomes: sessionPromotionOutcomes,
      gateway: this.context.gateway,
      captureScope: () => this.captureHeaderSessionActionScope(),
      outcomeOwner: () => this.headerOutcomeOwner,
      isScopeCurrent: (scope, owner) => this.isHeaderSessionActionCurrent(scope, owner),
      publishError: (error, owner) => this.publishHeaderError(error, owner),
      title: (candidate) => this.resolveHeaderSessionTitle(candidate),
      requestUpdate: () => this.requestUpdate(),
    });
  }

  protected captureHeaderSessionActionScope():
    | (SidebarSessionMutationScope & { signal: AbortSignal })
    | null {
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    if (gateway.snapshot.phase !== "connected" || !client) {
      return null;
    }
    return {
      epoch: this.connectionGeneration,
      context: this.context,
      gateway,
      sessions: this.context.sessions,
      client,
      selectedAgentId: this.context.agentSelection.state.selectedId ?? "main",
      signal: this.headerSessionMutationAbortController.signal,
    };
  }

  protected isHeaderSessionActionCurrent(
    scope: SidebarSessionMutationScope,
    owner: string,
  ): boolean {
    return (
      this.ownsHeaderOutcome(owner) &&
      this.isConnected &&
      this.context === scope.context &&
      this.context.gateway === scope.gateway &&
      this.context.sessions === scope.sessions &&
      scope.gateway.snapshot.phase === "connected" &&
      scope.gateway.snapshot.client === scope.client
    );
  }
}
