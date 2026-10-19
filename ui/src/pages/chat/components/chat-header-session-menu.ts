import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { UiSettings } from "../../../app/settings.ts";
import { renderBoardGrantedCapabilities } from "../../../components/board/board-widget-capabilities.ts";
import {
  renderBoardWidgetMenuItems,
  type BoardWidgetPageMenu,
} from "../../../components/board/board-widget-cell-render.ts";
import { icons } from "../../../components/icons.ts";
import { activateMenuShortcut } from "../../../components/menu-shortcuts.ts";
import {
  EMPTY_SESSION_MENU_DATA,
  SessionMenuActions,
  type SessionManagementAction,
  type SessionMenuData,
} from "../../../components/session-menu-actions.ts";
import {
  compactSessionMenuViewForValue,
  renderCompactSessionMenuFrame,
  renderCompactSessionMenuNavigationItem,
  type CompactSessionMenuView,
} from "../../../components/session-menu-compact.ts";
import type { SessionCreatedActor } from "../../../components/session-owner-chip.ts";
import { t } from "../../../i18n/index.ts";
import {
  canRequestPromotion,
  pendingCancelRequestId,
} from "../../../lib/sessions/session-promotion-gate.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  canManageChatSessionSharing,
  renderChatSessionSharing,
  selectChatSessionSharingItem,
  type ChatSessionSharingProps,
} from "./chat-session-sharing.ts";

export type HeaderMenuAction =
  | SessionManagementAction
  | { kind: "promote-session" }
  | { kind: "cancel-promotion" }
  | { kind: "check-promotion" }
  | { kind: "continue-in-terminal" }
  | { kind: "stop-cloud-worker" }
  | { kind: "plugin"; id: string };
export type HeaderMenuActionKind = HeaderMenuAction["kind"];

export type HeaderMenuQuickAction = {
  id: string;
  label: string;
  icon: TemplateResult;
  description?: string;
  variant?: "danger";
} & (
  | { kind: "status" }
  | {
      kind?: "action";
      active?: boolean;
      badge?: number;
      disabled?: boolean;
      onActivate: () => void;
    }
);

const EMPTY_SETTINGS = {} as UiSettings;

type CompactMenuView = CompactSessionMenuView | "panels" | "layout" | "sharing" | "view";
type MenuSelectEvent = CustomEvent<{ item: { value?: string } }> & {
  currentTarget: HTMLElement & { open: boolean };
};

const COMPACT_MENU_VIEW_BY_VALUE: Record<string, CompactMenuView> = {
  "compact:open-layout": "layout",
  "compact:open-panels": "panels",
  "compact:open-sharing": "sharing",
  "compact:open-view": "view",
};

/**
 * One glyph per capability state (peacock status vocabulary). The glyph is decoration only: the
 * full words are the badge's accessible name, tooltip and live announcement, and open the details.
 */
const CAPABILITY_GLYPHS = {
  delegated: "🔒",
  ordinary: "👤",
  pending: "⏳",
  unknown: "⚪",
  denied: "🔴",
} as const;

let capabilityDetailsIds = 0;

/** Light DOM: each header (split panes included) needs its own aria-controls target. */
function nextCapabilityDetailsId() {
  capabilityDetailsIds += 1;
  return `session-capability-details-${capabilityDetailsIds}`;
}

class ChatHeaderSessionMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) session: SessionMenuData = EMPTY_SESSION_MENU_DATA;
  @property({ attribute: false }) worktreePath: string | null = null;
  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) preferencesBrowserOnly = false;
  @property({ attribute: false }) compact = false;
  @property({ attribute: false }) copyMarkdownAllowed = false;
  @property({ attribute: false }) splitAllowed = false;
  @property({
    attribute: false,
    hasChanged: (next: UiSettings, previous?: UiSettings) =>
      next?.chatShowThinking !== previous?.chatShowThinking ||
      next?.chatShowToolCalls !== previous?.chatShowToolCalls ||
      next?.chatPersistCommentary !== previous?.chatPersistCommentary,
  })
  settings: UiSettings = EMPTY_SETTINGS;
  @property({ attribute: false }) panelActions: HeaderMenuQuickAction[] = [];
  @property({ attribute: false }) layoutActions: HeaderMenuQuickAction[] = [];
  @property({ attribute: false }) sessionActions: HeaderMenuQuickAction[] = [];
  @property({ attribute: false }) boardWidgetMenu?: BoardWidgetPageMenu;
  @property({ attribute: false }) sharing: ChatSessionSharingProps | null = null;
  @property({
    attribute: false,
    hasChanged: (next: readonly string[], previous?: readonly string[]) =>
      next.length !== previous?.length || next.some((group, index) => group !== previous?.[index]),
  })
  groups: readonly string[] = [];
  @property({ attribute: false }) currentOwner: SessionCreatedActor | null = null;
  @property({ attribute: false }) actionDisabledReasons: Partial<
    Record<HeaderMenuActionKind, string>
  > = {};
  @property({ attribute: false }) forkDisabled = false;
  @property({ attribute: false }) forkFromLastCompleted = false;
  @property({ attribute: false }) archiveAllowed = false;
  @property({ attribute: false }) archiveShortcut = false;
  @property({ attribute: false }) deleteAllowed = false;
  @property({ attribute: false }) onOpen: () => void = () => {};
  @property({ attribute: false }) onOpenCommandPalette: () => void = () => {};
  @property({ attribute: false }) onSettingsChange: (patch: Partial<UiSettings>) => void = () => {};
  @property({ attribute: false }) onAction: (action: HeaderMenuAction) => void = () => {};
  @state() private compactView: CompactMenuView = "root";
  @state() private capabilityDetailsOpen = false;
  private readonly capabilityDetailsId = nextCapabilityDetailsId();
  private readonly managementActions = new SessionMenuActions(
    this,
    () => ({
      session: this.session,
      selectionCount: 1,
      compact: this.compact,
      navigationAllowed: true,
      copyMarkdownAllowed: this.copyMarkdownAllowed,
      splitAllowed: this.splitAllowed,
      renderOpenInExtra: (inline) => this.renderTerminalAction(inline),
      disabled: false,
      actionDisabledReasons: this.actionDisabledReasons,
      forkDisabled: this.forkDisabled,
      forkFromLastCompleted: this.forkFromLastCompleted,
      archiveAllowed: this.archiveAllowed,
      archiveShortcut: this.archiveShortcut,
      deleteAllowed: this.deleteAllowed,
      groups: this.groups,
      currentOwner: this.currentOwner,
      worktreePath: this.worktreePath,
    }),
    (action) => this.onAction(action),
    () => {
      const dropdown = this.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
      if (dropdown) {
        dropdown.open = false;
      }
    },
  );

  private readonly handleSelect = (event: MenuSelectEvent) => {
    const promotionValue = event.detail.item.value ?? "";
    if (["promote-session", "cancel-promotion", "check-promotion"].includes(promotionValue)) {
      const status = this.session.capabilityStatus;
      if (
        !this.session.promotionBusy &&
        !this.session.promotionDisabledReason &&
        (promotionValue === "check-promotion" ||
          (this.session.key &&
            this.session.sessionId &&
            !this.session.promotionUncertain &&
            (promotionValue === "cancel-promotion"
              ? pendingCancelRequestId(status)
              : canRequestPromotion(status))))
      ) {
        this.onAction({
          kind: promotionValue as "promote-session" | "cancel-promotion" | "check-promotion",
        });
      }
      return;
    }
    const value = event.detail.item.value;
    if (!value) {
      return;
    }
    if (value.startsWith("board-widget:")) {
      this.boardWidgetMenu?.onSelect(value.slice("board-widget:".length));
      return;
    }
    const managementView = compactSessionMenuViewForValue(value);
    const compactView = managementView ?? COMPACT_MENU_VIEW_BY_VALUE[value];
    if (compactView) {
      event.preventDefault();
      this.compactView = compactView;
      if (managementView) {
        this.managementActions.prepareCompactView(managementView);
      } else if (compactView === "sharing" && !this.sharing?.openDisabledReason) {
        this.sharing?.onOpen();
      }
      this.managementActions.focusCurrentView();
      return;
    }
    if (value === "open-command-palette") {
      this.onOpenCommandPalette();
      return;
    }
    if (value.startsWith("quick:")) {
      const [, group, id] = value.split(":");
      const actions =
        group === "panels"
          ? this.panelActions
          : group === "session"
            ? this.sessionActions
            : this.layoutActions;
      const action = actions.find((candidate) => candidate.id === id);
      if (action && action.kind !== "status" && !action.disabled) {
        action.onActivate();
      }
      return;
    }
    if (value.startsWith("view:")) {
      event.preventDefault();
      if (this.onboarding) {
        return;
      }
      const setting = value.slice("view:".length);
      if (setting === "reasoning") {
        this.onSettingsChange({ chatShowThinking: !this.settings.chatShowThinking });
      } else if (setting === "tool-calls") {
        this.onSettingsChange({ chatShowToolCalls: !this.settings.chatShowToolCalls });
      } else if (setting === "commentary") {
        this.onSettingsChange({
          chatPersistCommentary: this.settings.chatPersistCommentary === false,
        });
      }
      return;
    }
    if (
      value.startsWith("visibility:") ||
      value.startsWith("member:") ||
      value.startsWith("public:")
    ) {
      if (this.sharing) {
        selectChatSessionSharingItem(this.sharing, value);
      }
      return;
    }
    if (this.managementActions.handleSelect(value)) {
      event.preventDefault();
      return;
    }
    if (value === "continue-in-terminal" && !this.actionDisabledReasons[value]) {
      event.currentTarget.open = false;
      this.onAction({ kind: value });
    }
  };

  private renderQuickActionItems(
    group: "panels" | "layout" | "session",
    actions: HeaderMenuQuickAction[],
    inline = false,
  ) {
    return actions.map((action) => {
      const label = html`<span class="session-menu__text"
        >${action.label}${
          action.description
            ? html`<span class="session-menu__description">${action.description}</span>`
            : nothing
        }</span
      >`;
      if (action.kind === "status") {
        return html`<div
          slot=${inline ? nothing : "submenu"}
          class="session-menu__status"
          data-menu-status=${action.id}
          role="note"
        >
          <span class="session-menu__check" aria-hidden="true">${action.icon}</span>
          ${label}
        </div>`;
      }
      const detail =
        typeof action.badge === "number" && action.badge > 0
          ? html`<span slot="details" class="session-menu__sub">${action.badge}</span>`
          : nothing;
      return html`
        <wa-dropdown-item
          slot=${inline ? nothing : "submenu"}
          class="session-menu__item"
          value=${`quick:${group}:${action.id}`}
          type=${action.active === undefined ? nothing : "checkbox"}
          .checked=${action.active ?? false}
          ?disabled=${action.disabled}
          variant=${action.variant ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${action.icon}</span>
          ${label} ${detail}
        </wa-dropdown-item>
      `;
    });
  }

  private renderSubmenu(group: "panels" | "layout" | "view") {
    const actions = group === "panels" ? this.panelActions : this.layoutActions;
    if (group !== "view" && actions.length === 0) {
      return nothing;
    }
    const label = t(
      group === "view"
        ? "chat.view.menu"
        : group === "panels"
          ? "chat.sessionHeader.panels"
          : "chat.sessionHeader.layout",
    );
    const icon =
      group === "view" ? icons.eye : group === "panels" ? icons.panelRightOpen : icons.columns2;
    if (this.compact) {
      return renderCompactSessionMenuNavigationItem({
        value: `compact:open-${group}`,
        label,
        icon,
      });
    }
    return html`
      <wa-dropdown-item class="session-menu__item">
        <span slot="icon" class="session-menu__icon" aria-hidden="true">${icon}</span>
        <span class="session-menu__text">${label}</span>
        ${group === "view" ? this.renderViewSubmenu() : this.renderQuickActionItems(group, actions)}
      </wa-dropdown-item>
    `;
  }

  private renderViewSubmenu(inline = false) {
    const showThinking = this.onboarding ? false : this.settings.chatShowThinking;
    const showToolCalls = this.onboarding ? true : this.settings.chatShowToolCalls;
    const persistCommentary = this.settings.chatPersistCommentary !== false;
    const disabledTitle = this.onboarding ? t("chat.onboardingDisabled") : nothing;
    const item = (value: string, label: string, checked: boolean) => html`
      <wa-dropdown-item
        slot=${inline ? nothing : "submenu"}
        class="session-menu__item"
        type="checkbox"
        value=${`view:${value}`}
        .checked=${checked}
        ?disabled=${this.onboarding}
        title=${disabledTitle}
      >
        <span class="session-menu__text">${label}</span>
      </wa-dropdown-item>
    `;
    return html`
      ${item("reasoning", t("chat.view.reasoning"), showThinking)}
      ${item("tool-calls", t("chat.view.toolCalls"), showToolCalls)}
      ${item("commentary", t("chat.view.commentary"), persistCommentary)}
      ${
        this.preferencesBrowserOnly
          ? html`<div slot=${inline ? nothing : "submenu"} class="session-menu__info" role="note">
              ${t("quickSettings.personal.browserOnly")}
            </div>`
          : nothing
      }
    `;
  }

  private renderCompactView() {
    if (
      this.compactView === "root" ||
      this.compactView === "open-in" ||
      this.compactView === "copy" ||
      this.compactView === "assign-owner" ||
      this.compactView === "icon" ||
      this.compactView === "group"
    ) {
      return this.managementActions.renderCompactView(this.compactView);
    }
    const body = html`${
      this.compactView === "panels"
        ? this.renderQuickActionItems("panels", this.panelActions, true)
        : this.compactView === "layout"
          ? this.renderQuickActionItems("layout", this.layoutActions, true)
          : this.compactView === "sharing" && this.sharing
            ? renderChatSessionSharing(this.sharing, true)
            : this.renderViewSubmenu(true)
    }`;
    return renderCompactSessionMenuFrame(body);
  }

  private renderRootView() {
    return html`
      ${
        this.compact
          ? html`<wa-dropdown-item class="session-menu__item" value="open-command-palette">
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${icons.search}</span
                >
                <span class="session-menu__text">${t("chat.openCommandPalette")}</span>
              </wa-dropdown-item>
              <div class="session-menu__separator" role="separator"></div>`
          : nothing
      }
      ${
        this.boardWidgetMenu
          ? html`
              <div class="board-widget__page-menu-heading">
                <strong
                  >${this.boardWidgetMenu.widget.title || this.boardWidgetMenu.widget.name}</strong
                >
              </div>
              ${renderBoardGrantedCapabilities(this.boardWidgetMenu.widget, "details")}
              ${
                this.boardWidgetMenu.canMutate
                  ? renderBoardWidgetMenuItems({
                      widget: this.boardWidgetMenu.widget,
                      tabs: this.boardWidgetMenu.tabs,
                      disabled: false,
                      prefix: "board-widget:",
                    })
                  : nothing
              }
              <div class="session-menu__separator" role="separator"></div>
            `
          : nothing
      }
      ${this.renderSubmenu("panels")} ${this.renderSubmenu("layout")}
      ${
        this.compact && this.sharing?.session && canManageChatSessionSharing(this.sharing.session)
          ? renderCompactSessionMenuNavigationItem({
              value: "compact:open-sharing",
              label: t("chat.sessionSharing.menu"),
              icon: icons.users,
              disabled: Boolean(this.sharing.openDisabledReason),
            })
          : nothing
      }
      ${this.renderSubmenu("view")}
      <div class="session-menu__separator" role="separator"></div>
      ${this.renderPromotionActions()} ${this.managementActions.renderPrimaryActions()}
      <div class="session-menu__separator" role="separator"></div>
      ${this.managementActions.renderOrganizationActions()}
      ${this.renderQuickActionItems("session", this.sessionActions, true)}
      <div class="session-menu__separator" role="separator"></div>
      ${this.managementActions.renderTransferActions()}
      <div class="session-menu__separator" role="separator"></div>
      ${this.managementActions.renderDeleteAction()}
    `;
  }

  private renderTerminalAction(inline: boolean) {
    return html`<wa-dropdown-item
      slot=${inline ? nothing : "submenu"}
      class="session-menu__item"
      value="continue-in-terminal"
      ?disabled=${Boolean(this.actionDisabledReasons["continue-in-terminal"])}
      title=${this.actionDisabledReasons["continue-in-terminal"] ?? nothing}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.terminal}</span>
      <span class="session-menu__text">${t("chat.sessionHeader.continueInTerminal.action")}</span>
    </wa-dropdown-item>`;
  }

  private readonly handleShow = () => {
    this.compactView = "root";
    this.managementActions.loadOwners();
    this.onOpen();
  };

  private capabilityBadge(): { glyph: string; label: string } {
    const badge = (glyph: keyof typeof CAPABILITY_GLYPHS, key: string) => ({
      glyph: CAPABILITY_GLYPHS[glyph],
      label: t(key),
    });
    if (this.session.promotionBusy) {
      return badge("pending", "chat.sessionHeader.promotion.busy");
    }
    const status = this.session.capabilityStatus;
    if (this.session.promotionUncertain) {
      return badge("unknown", "chat.sessionHeader.promotion.uncertain");
    }
    if (this.session.promotionDenied) {
      return badge("denied", "chat.sessionHeader.promotion.notAllowed");
    }
    if (!status || status.effectiveClass === "unknown") {
      return badge("unknown", "chat.sessionHeader.capabilityUnknown");
    }
    if (status.promotionState === "pending") {
      return badge("pending", "chat.sessionHeader.promotion.pending");
    }
    if (status.promotionState === "blocked" || status.promotionState === "revoked") {
      return badge("denied", "chat.sessionHeader.promotion.denied");
    }
    if (status.effectiveClass === "delegated") {
      return badge(
        "delegated",
        status.classScope === "requesting-human-direct-turns"
          ? "chat.sessionHeader.promotion.promotedForOther"
          : "chat.sessionHeader.capabilityDelegated",
      );
    }
    if (status.classScope === "requesting-human-direct-turns") {
      return badge("ordinary", "chat.sessionHeader.promotion.ordinaryDirectTurns");
    }
    return badge(
      "ordinary",
      status.effectiveRestrictions.length || status.capabilities.sessionsSend !== "allowed"
        ? "chat.sessionHeader.promotion.ordinaryLimited"
        : "chat.sessionHeader.promotion.ordinary",
    );
  }

  private readonly closeCapabilityDetailsOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !this.capabilityDetailsOpen) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.capabilityDetailsOpen = false;
    this.querySelector<HTMLButtonElement>(".session-capability-details-toggle")?.focus();
  };

  private renderPromotionActions() {
    const status = this.session.capabilityStatus;
    const pending = status?.promotionState === "pending";
    const identified = Boolean(this.session.key && this.session.sessionId);
    const unavailableReason = pending
      ? !identified || !pendingCancelRequestId(status)
        ? t("chat.sessionHeader.promotion.cancelUnavailable")
        : undefined
      : status?.disabledReasons.join("; ") ||
        (!identified || !canRequestPromotion(status)
          ? t("chat.sessionHeader.promotion.unavailable")
          : undefined);
    const reason =
      this.session.promotionDisabledReason ??
      (this.session.promotionBusy ? t("chat.sessionHeader.promotion.busy") : unavailableReason);
    return html`
      ${
        // No capability status is no promotion offer: an unknown session shows no disabled item.
        (status && status.effectiveClass !== "ordinary") || pending
          ? html`
              <wa-dropdown-item
                class="session-menu__item session-promotion-action"
                value=${pending ? "cancel-promotion" : "promote-session"}
                ?disabled=${Boolean(reason) || Boolean(this.session.promotionUncertain)}
                title=${reason ?? ""}
              >
                <span class="session-menu__text"
                  >${t(pending ? "chat.sessionHeader.promotion.cancel" : "chat.sessionHeader.promotion.action")}</span
                >
              </wa-dropdown-item>
              ${reason ? html`<div class="session-menu__info" role="note">${reason}</div>` : nothing}
            `
          : nothing
      }
      <wa-dropdown-item
        class="session-menu__item session-promotion-action"
        value="check-promotion"
        ?disabled=${Boolean(this.session.promotionBusy || this.session.promotionDisabledReason)}
      >
        <span class="session-menu__text">${t("chat.sessionHeader.promotion.check")}</span>
      </wa-dropdown-item>
    `;
  }

  override render() {
    const menuLabel = t("chat.sidebar.sessionMenu", { session: this.session.label });
    const capability = this.capabilityBadge();
    const detailsLabel = t("chat.sessionHeader.promotion.details");
    return html`
      <span
        class="session-capability-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label=${capability.label}
        title=${capability.label}
        ><span class="session-capability-status__glyph" aria-hidden="true">${capability.glyph}</span
        ><span class="sr-only">${capability.label}</span></span
      >
      <button
        class="btn btn--ghost btn--icon chat-icon-btn session-capability-details-toggle"
        type="button"
        aria-label=${detailsLabel}
        title=${detailsLabel}
        aria-expanded=${String(this.capabilityDetailsOpen)}
        aria-controls=${this.capabilityDetailsId}
        @click=${() => {
          this.capabilityDetailsOpen = !this.capabilityDetailsOpen;
        }}
        @keydown=${this.closeCapabilityDetailsOnEscape}
      >
        ${icons.info}
      </button>
      <div
        id=${this.capabilityDetailsId}
        class="session-capability-details"
        role="region"
        aria-label=${detailsLabel}
        ?hidden=${!this.capabilityDetailsOpen}
        @keydown=${this.closeCapabilityDetailsOnEscape}
      >
        <div class="session-capability-details__class">${capability.glyph} ${capability.label}</div>
        <div>${t("chat.sessionHeader.promotion.explanation")}</div>
        <div>${this.session.promotionMessage ?? ""}</div>
        <div>
          ${this.session.capabilityStatus?.historicalOrigin === "delegated" ? t("chat.sessionHeader.promotion.origin") : ""}
        </div>
        <div>
          ${this.session.capabilityStatus?.classScope === "requesting-human-direct-turns" ? t("chat.sessionHeader.promotion.scope") : ""}
        </div>
        <ul>
          ${[...(this.session.capabilityStatus?.disabledReasons ?? []), ...(this.session.capabilityStatus?.pendingBlockers ?? []), ...(this.session.capabilityStatus?.effectiveRestrictions ?? [])].map((reason) => html`<li>${reason}</li>`)}
        </ul>
        <div>
          ${t("chat.sessionHeader.promotion.send", { status: this.session.capabilityStatus?.capabilities.sessionsSend ?? "unknown" })}
        </div>
        <div>${this.session.capabilityStatus?.activationBoundary ?? ""}</div>
      </div>
      <wa-dropdown
        class=${`session-menu chat-header-session-menu${this.compact ? " session-menu--compact chat-header-session-menu--compact" : ""}${this.compact && this.compactView === "sharing" ? " chat-header-session-menu--compact-sharing" : ""}`}
        placement="bottom-end"
        aria-label=${menuLabel}
        @keydown=${(event: KeyboardEvent) => {
          if (!this.managementActions.handleKeydown(event)) {
            activateMenuShortcut(this, event);
          }
        }}
        @wa-show=${this.handleShow}
        @wa-select=${this.handleSelect}
      >
        <button
          slot="trigger"
          class="btn btn--ghost btn--icon chat-icon-btn chat-header-session-menu__trigger"
          type="button"
          aria-label=${menuLabel}
          aria-haspopup="menu"
        >
          ${icons.moreHorizontal}
        </button>
        ${
          this.compact && this.compactView !== "root"
            ? this.renderCompactView()
            : this.renderRootView()
        }
      </wa-dropdown>
    `;
  }
}

if (!customElements.get("openclaw-chat-header-session-menu")) {
  customElements.define("openclaw-chat-header-session-menu", ChatHeaderSessionMenu);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-header-session-menu": ChatHeaderSessionMenu;
  }
}
