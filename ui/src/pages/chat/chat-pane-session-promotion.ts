import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SidebarSessionMutationScope } from "../../components/app-sidebar-session-types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionPromotionEnglish } from "../../i18n/locales/en-session-promotion.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  canRequestPromotion,
  pendingCancelRequestId,
} from "../../lib/sessions/session-promotion-gate.ts";
import { ChatPaneContext } from "./chat-pane-context.ts";

registerSessionPromotionEnglish();

export type PromotionUiState = {
  busy: boolean;
  uncertain: boolean;
  /** The Gateway answered with a definite refusal; distinct from an unknown outcome. */
  denied?: boolean;
  message?: string;
};
export type PromotionKind = "promote-session" | "cancel-promotion" | "check-promotion";

/**
 * Local busy/uncertain/message state, bound to the Gateway connection owner (controller and
 * URL), the session key and the session instance. A different Gateway or a replacement session
 * with the same key therefore starts clean, while the original target stays uncertain.
 */
export class PromotionOutcomeStore {
  private readonly byGateway = new WeakMap<object, Map<string, PromotionUiState>>();

  private id(gatewayUrl: string, row: GatewaySessionRow): string {
    return JSON.stringify([gatewayUrl, row.key, row.sessionId ?? null]);
  }

  read(
    gateway: { connection: { gatewayUrl: string } },
    row: GatewaySessionRow,
  ): PromotionUiState | undefined {
    return this.byGateway.get(gateway)?.get(this.id(gateway.connection.gatewayUrl, row));
  }

  write(
    gateway: { connection: { gatewayUrl: string } },
    row: GatewaySessionRow,
    state: PromotionUiState,
  ): void {
    const states = this.byGateway.get(gateway) ?? new Map<string, PromotionUiState>();
    states.set(this.id(gateway.connection.gatewayUrl, row), state);
    this.byGateway.set(gateway, states);
  }
}

type SessionPromotionHost = {
  outcomes: PromotionOutcomeStore;
  gateway: { connection: { gatewayUrl: string } };
  captureScope(): (SidebarSessionMutationScope & { signal: AbortSignal }) | null;
  outcomeOwner(): string;
  isScopeCurrent(scope: SidebarSessionMutationScope, owner: string): boolean;
  publishError(error: unknown, owner?: string): void;
  title(row: GatewaySessionRow): string;
  requestUpdate(): void;
};

/**
 * A Gateway reply that decided the request: a denial (FORBIDDEN, or INVALID_REQUEST for an
 * unsupported target) or a changed target. Transport loss, timeouts and retryable outages are
 * not decisions and stay "unknown".
 */
function definiteRefusal(
  error: unknown,
): { kind: "denied"; reason?: string } | { kind: "changed" } | undefined {
  if (!(error instanceof GatewayRequestError) || error.retryable) {
    return undefined;
  }
  const details = error.details as { code?: unknown; reason?: unknown } | undefined;
  if (error.gatewayCode === "INVALID_REQUEST" && details?.code === "SESSION_PROMOTION_CONFLICT") {
    return { kind: "changed" };
  }
  if (error.gatewayCode !== "FORBIDDEN" && error.gatewayCode !== "INVALID_REQUEST") {
    return undefined;
  }
  return {
    kind: "denied",
    ...(typeof details?.reason === "string" ? { reason: details.reason } : {}),
  };
}

/** Request, cancel and read-only status check for one session promotion handoff. */
async function runSessionPromotion(
  kind: PromotionKind,
  row: GatewaySessionRow,
  host: SessionPromotionHost,
): Promise<void> {
  const scope = host.captureScope();
  if (!scope) {
    host.publishError(t("sessionsView.actionRequiresConnection"));
    return;
  }
  const owner = host.outcomeOwner();
  const current = () =>
    scope.sessions.state.result?.sessions.find((candidate) => candidate.key === row.key);
  const expectedSessionId = row.sessionId;
  const previousProjection = current()?.promotion;
  const expectedLifecycleRevision = row.promotion?.lifecycleRevision;
  // Cancel targets the original pending intent from this same projection read.
  const cancelRequestId = pendingCancelRequestId(row.promotion);
  const cancel = kind === "cancel-promotion";
  const isCurrent = () => host.isScopeCurrent(scope, owner) && !scope.signal.aborted;
  const sameTarget = () => {
    const latest = current();
    return (
      latest?.sessionId === expectedSessionId &&
      latest?.promotion?.lifecycleRevision === expectedLifecycleRevision
    );
  };
  const eligible = () =>
    cancel
      ? Boolean(cancelRequestId) && pendingCancelRequestId(current()?.promotion) === cancelRequestId
      : canRequestPromotion(current()?.promotion);
  let ui = host.outcomes.read(host.gateway, row);
  if (ui?.busy || (kind !== "check-promotion" && ui?.uncertain)) {
    return;
  }
  if (
    !isCurrent() ||
    (kind !== "check-promotion" &&
      (!sameTarget() || !expectedSessionId || !expectedLifecycleRevision || !eligible()))
  ) {
    host.publishError(t("chat.sessionHeader.promotion.stale"), owner);
    return;
  }
  ui = { busy: true, uncertain: ui?.uncertain ?? false };
  host.outcomes.write(host.gateway, row, ui);
  host.requestUpdate();
  let submitted = false;
  let decided = false;
  try {
    if (kind !== "check-promotion") {
      const confirmed = await showConfirmDialog({
        title: t(
          cancel
            ? "chat.sessionHeader.promotion.cancelTitle"
            : "chat.sessionHeader.promotion.confirmTitle",
          { session: host.title(row) },
        ),
        details: row.key,
        message: t(
          cancel
            ? "chat.sessionHeader.promotion.cancelExplanation"
            : "chat.sessionHeader.promotion.explanation",
        ),
        confirmLabel: t(
          cancel
            ? "chat.sessionHeader.promotion.cancelConfirm"
            : "chat.sessionHeader.promotion.confirm",
        ),
        signal: scope.signal,
      });
      if (!confirmed) {
        return;
      }
      if (!isCurrent() || !sameTarget() || !eligible()) {
        host.publishError(t("chat.sessionHeader.promotion.stale"), owner);
        return;
      }
      submitted = true;
      await scope.client.request("sessions.promote", {
        key: row.key,
        expectedSessionId: expectedSessionId!,
        expectedLifecycleRevision: expectedLifecycleRevision!,
        requestId: cancel ? cancelRequestId! : crypto.randomUUID(),
        action: cancel ? "cancel" : "request",
      });
      // A transport acknowledgement is not proof of activation. Only the refreshed
      // Gateway projection determines pending/ordinary/denied state.
      ui.uncertain = true;
    }
    if (!isCurrent()) {
      return;
    }
    await scope.sessions.refresh({ force: true });
    if (!isCurrent()) {
      return;
    }
    const latest = current();
    if (
      !latest ||
      (expectedSessionId && latest.sessionId !== expectedSessionId) ||
      !latest.promotion?.lifecycleRevision ||
      scope.sessions.state.error ||
      scope.sessions.state.loading ||
      latest.promotion === previousProjection
    ) {
      ui.uncertain = true;
      ui.message = t("chat.sessionHeader.promotion.stale");
      return;
    }
    ui.uncertain = false;
    ui.message = t("chat.sessionHeader.promotion.checked");
  } catch (error) {
    const refusal = submitted ? definiteRefusal(error) : undefined;
    if (refusal) {
      decided = true;
      ui.uncertain = false;
      ui.denied = refusal.kind === "denied";
      // Show the Gateway's current projection; failing to refresh casts no doubt on the reply.
      if (isCurrent()) {
        await scope.sessions.refresh({ force: true }).catch(() => undefined);
      }
      const reasons = [
        ...new Set([
          ...(refusal.kind === "denied" && refusal.reason ? [refusal.reason] : []),
          ...(current()?.promotion?.disabledReasons ?? []),
        ]),
      ];
      ui.message =
        refusal.kind === "changed"
          ? t("chat.sessionHeader.promotion.stale")
          : reasons.length
            ? t("chat.sessionHeader.promotion.notAllowedReason", { reason: reasons.join("; ") })
            : t("chat.sessionHeader.promotion.notAllowed");
      if (isCurrent()) {
        host.publishError(ui.message, owner);
      }
      return;
    }
    ui.uncertain = submitted || kind === "check-promotion" || ui.uncertain;
    ui.message = ui.uncertain ? t("chat.sessionHeader.promotion.uncertain") : formatUiError(error);
    if (isCurrent()) {
      host.publishError(ui.message, owner);
    }
  } finally {
    // Retain uncertain state even when the pane changes during the request.
    if (submitted && !decided && !isCurrent()) {
      ui.uncertain = true;
    }
    ui.busy = false;
    host.requestUpdate();
  }
}

export abstract class ChatPaneSessionPromotion extends ChatPaneContext {
  private readonly promotionOutcomes = new PromotionOutcomeStore();

  protected abstract resolveHeaderSessionTitle(row: GatewaySessionRow | undefined): string;

  protected readPromotionOutcome(row: GatewaySessionRow): PromotionUiState | undefined {
    return this.promotionOutcomes.read(this.context.gateway, row);
  }

  protected handleSessionPromotion(kind: PromotionKind, row: GatewaySessionRow): Promise<void> {
    return runSessionPromotion(kind, row, {
      outcomes: this.promotionOutcomes,
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
