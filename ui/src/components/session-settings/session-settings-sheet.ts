import { ContextConsumer } from "@lit/context";
import { html, nothing, render, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import type { BoardSnapshot } from "../../../../packages/gateway-protocol/src/schema/board.js";
import type { SessionsProcessesListResult } from "../../../../packages/gateway-protocol/src/schema/session-processes.js";
import type {
  CronJobsListResult,
  GatewaySessionRow,
  SessionsListResult,
  SessionsUsageResult,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import { applicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionSettingsEnglish } from "../../i18n/locales/en-session-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { requestSessionUsage } from "../../lib/sessions/usage.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { icons } from "../icons.ts";
import "../modal-dialog.ts";
import type { OpenClawModalDialog } from "../modal-dialog.ts";
import { EMPTY_SESSION_MENU_DATA, type SessionMenuData } from "../session-menu-actions.ts";
import type { SessionCreatedActor } from "../session-owner-chip.ts";
import { SessionOwnerMenu } from "../session-owner-menu.ts";
import {
  resolveSessionSettingsActions,
  type SessionSettingsHostAction,
} from "./session-settings-actions.ts";
import {
  countChildSessions,
  renderActivitySection,
  renderClassSection,
  renderDashboardSection,
  renderIdentitySection,
  renderLineageSection,
  renderModelsSection,
  renderPermissionsSection,
  renderUsageSection,
  type LineageChildren,
  type SectionLoad,
} from "./session-settings-sections.ts";
import "../../styles/session-settings.css";

registerSessionSettingsEnglish();

export const SESSION_SETTINGS_SECTIONS = [
  "identity",
  "class",
  "lineage",
  "permissions",
  "models",
  "usage",
  "activity",
  "dashboard",
  "actions",
] as const;
export type SessionSettingsSectionId = (typeof SESSION_SETTINGS_SECTIONS)[number];

/** Open on first show: what the session is and what it may do. The rest load when opened. */
const DEFAULT_OPEN: readonly SessionSettingsSectionId[] = ["class", "permissions"];

type LoadId = "children" | "tools" | "usage" | "modelRow" | "processes" | "automations" | "board";
type Loads = {
  children: LineageChildren;
  tools: ToolsEffectiveResult;
  usage: SessionsUsageResult;
  /** Full row for this session; compact list rows omit the fallback ladder. */
  modelRow: GatewaySessionRow | null;
  processes: SessionsProcessesListResult;
  automations: CronJobsListResult;
  board: BoardSnapshot;
};

const SECTION_LOADS: Partial<Record<SessionSettingsSectionId, readonly LoadId[]>> = {
  lineage: ["children"],
  permissions: ["tools"],
  models: ["usage", "modelRow"],
  activity: ["processes", "automations"],
  dashboard: ["board"],
};

const LOAD_METHODS: Record<LoadId, string> = {
  children: "sessions.list",
  tools: "tools.effective",
  usage: "sessions.usage",
  modelRow: "sessions.describe",
  processes: "sessions.processes.list",
  automations: "cron.list",
  board: "board.get",
};

function localDate(ms: number) {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

let sheetIds = 0;

function nextSheetId() {
  sheetIds += 1;
  return `session-settings-${sheetIds}`;
}

/**
 * Right-side "Session settings" sheet. Hosts (the chat header and the sidebar session menu) pass
 * the row and the menu facts they already hold and run actions through their existing handlers;
 * the sheet itself only reads, each section lazily on first open from existing Gateway methods.
 */
class SessionSettingsSheet extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) open = false;
  @property({ attribute: false }) row: GatewaySessionRow | undefined = undefined;
  @property({ attribute: false }) session: SessionMenuData = EMPTY_SESSION_MENU_DATA;
  /** The words the header badge uses, repeated in Class while a promotion outcome is in flight. */
  @property({ attribute: false }) capabilityLabel = "";
  @property({ attribute: false }) groups: readonly string[] = [];
  @property({ attribute: false }) currentOwner: SessionCreatedActor | null = null;
  @property({ attribute: false }) archiveAllowed = false;
  @property({ attribute: false }) actionDisabledReasons: Partial<Record<string, string>> = {};
  /** Hosts without a promotion status check leave it off; their action contract omits it. */
  @property({ attribute: false }) promotionCheck = true;
  /** Opened and scrolled to when the sheet opens, as the "!" marker will ask for Permissions. */
  @property({ attribute: false }) initialSection: SessionSettingsSectionId | null = null;
  /** Focus target after close; the opener, since a menu item that opened the sheet is gone. */
  @property({ attribute: false }) returnFocus: HTMLElement | null = null;
  @property({ attribute: false }) onAction: (action: SessionSettingsHostAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};
  @state() private expanded = new Set<SessionSettingsSectionId>(DEFAULT_OPEN);
  @state() private loads: { [Id in LoadId]?: SectionLoad<Loads[Id]> } = {};
  private readonly context = new ContextConsumer(this, {
    context: applicationContext,
    subscribe: true,
  });
  private readonly ownerMenu = new SessionOwnerMenu(this);
  private readonly sheetId = nextSheetId();
  private identity = "";
  private portal: HTMLElement | null = null;
  private ownersRequested = false;
  private client: unknown = null;
  private generation = 0;

  constructor() {
    super();
    new SubscriptionsController(this)
      .watchStore(() => this.context.value?.gateway)
      .watchStore(() => this.context.value?.sessions);
  }

  private get sessionKey(): string {
    return this.row?.key ?? this.session.key ?? "";
  }

  private get agentId(): string | undefined {
    return this.row?.agentId ?? parseAgentSessionKey(this.sessionKey)?.agentId;
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    // A different session, a replacement id or a reconnect starts the lazy reads over.
    const client = this.context.value?.gateway.snapshot.client ?? null;
    const identity = `${this.sessionKey}\u0000${this.session.sessionId ?? ""}`;
    if (identity !== this.identity || client !== this.client) {
      this.identity = identity;
      this.client = client;
      this.generation += 1;
      this.loads = {};
      this.ownersRequested = false;
    }
    if (changed.has("open") && this.open) {
      const status = this.session.capabilityStatus;
      // A promotion offer keeps Promote one tap away, as it was in the old info bubble.
      const promotable =
        status && (status.promotionState === "pending" || status.effectiveClass !== "ordinary");
      this.expanded = new Set([
        ...DEFAULT_OPEN,
        ...(promotable ? (["actions"] as const) : []),
        ...(this.initialSection ? [this.initialSection] : []),
      ]);
    }
    if (this.open) {
      for (const section of this.expanded) {
        this.loadSection(section);
      }
    }
  }

  protected override updated(changed: PropertyValues<this>) {
    if (!this.open) {
      this.closePortal();
      return;
    }
    if (!this.portal) {
      this.portal = document.createElement("div");
      this.portal.className = "session-settings-portal";
      document.body.append(this.portal);
    }
    render(this.renderSheet(), this.portal, { host: this });
    if (changed.has("open") && this.initialSection) {
      // The summary carries autofocus, so the dialog's own initial focus lands on it.
      this.portal
        .querySelector<HTMLElement>(`[data-section="${this.initialSection}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }

  override disconnectedCallback() {
    this.closePortal();
    super.disconnectedCallback();
  }

  private closePortal() {
    if (this.portal) {
      render(nothing, this.portal);
      this.portal.remove();
      this.portal = null;
    }
  }

  /** The rendered sheet, or null while closed. */
  get content(): HTMLElement | null {
    return this.portal;
  }

  private loadSection(section: SessionSettingsSectionId) {
    for (const id of SECTION_LOADS[section] ?? []) {
      if (!this.loads[id]) {
        this.runLoad(id);
      }
    }
    // The directory read is the owner picker's; once per session and connection is enough.
    if (section === "actions" && !this.ownersRequested) {
      this.ownersRequested = true;
      this.ownerMenu.load();
    }
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const client = this.context.value?.gateway.snapshot.client;
    if (!client || this.context.value?.gateway.snapshot.phase !== "connected") {
      return Promise.reject(new Error(t("chat.sessionSettings.disconnected")));
    }
    return client.request<T>(method, params);
  }

  private fetch(id: LoadId): Promise<Loads[LoadId]> {
    const key = this.sessionKey;
    const agentId = this.agentId;
    const agent = agentId ? { agentId } : {};
    switch (id) {
      case "children":
        return this.request<SessionsListResult>("sessions.list", {
          spawnedBy: key,
          archived: "all",
          ...agent,
        }).then(countChildSessions);
      case "tools":
        return this.request<ToolsEffectiveResult>("tools.effective", {
          sessionKey: key,
          ...agent,
        });
      case "modelRow":
        // sessions.list compact rows omit modelFallbacks on purpose. sessions.describe is the
        // existing per-session read that still returns the full row, including the ladder.
        return this.request<{ session: GatewaySessionRow | null }>("sessions.describe", {
          key,
          ...agent,
        }).then((result) => result.session);
      case "usage": {
        const client = this.context.value?.gateway.snapshot.client;
        if (!client) {
          return Promise.reject(new Error(t("chat.sessionSettings.disconnected")));
        }
        const created = this.row?.createdAt ?? Date.now() - 365 * 86_400_000;
        return requestSessionUsage(
          client,
          {
            startDate: localDate(created),
            endDate: localDate(Date.now()),
            scope: "instance",
            timeZone: "local",
            ...agent,
          },
          { key },
        );
      }
      case "processes":
        return this.request<SessionsProcessesListResult>("sessions.processes.list", {
          key,
          ...agent,
        });
      case "automations":
        return this.request<CronJobsListResult>("cron.list", {
          sessionKey: key,
          includeDisabled: true,
          includeDeliveryPreviews: false,
          limit: 20,
          offset: 0,
        });
      case "board":
        return this.request<BoardSnapshot>("board.get", { sessionKey: key, ...agent });
      default:
        return id satisfies never;
    }
  }

  private runLoad(id: LoadId) {
    const snapshot = this.context.value?.gateway.snapshot;
    if (!this.sessionKey) {
      return;
    }
    if (snapshot && isGatewayMethodAdvertised(snapshot, LOAD_METHODS[id]) === false) {
      this.loads = { ...this.loads, [id]: { status: "unavailable" } };
      return;
    }
    // Only the latest read of a section may settle it: a slow earlier attempt that a Retry
    // superseded, or one for the previous session, is dropped.
    const pending: SectionLoad<unknown> = { status: "loading" };
    const current = () => this.loads[id] === pending;
    this.loads = { ...this.loads, [id]: pending };
    this.fetch(id).then(
      (value) => {
        if (current()) {
          this.loads = { ...this.loads, [id]: { status: "done", value } };
        }
      },
      (error: unknown) => {
        if (current()) {
          this.loads = { ...this.loads, [id]: { status: "error", error: formatUiError(error) } };
        }
      },
    );
  }

  private readonly retry = (id: LoadId) => () => this.runLoad(id);

  private toggleSection(section: SessionSettingsSectionId, event: Event) {
    const open = (event.currentTarget as HTMLDetailsElement).open;
    if (open === this.expanded.has(section)) {
      return;
    }
    const expanded = new Set(this.expanded);
    if (open) {
      expanded.add(section);
    } else {
      expanded.delete(section);
    }
    this.expanded = expanded;
  }

  private parentLabel(): string | undefined {
    const parentKey = this.row?.parentSessionKey ?? this.row?.spawnedBy;
    if (!parentKey) {
      return undefined;
    }
    const parent = this.context.value?.sessions.state.result?.sessions.find(
      (candidate) => candidate.key === parentKey,
    );
    return parent ? resolveSessionDisplayName(parent.key, parent) : parentKey;
  }

  private renderActions() {
    const owners = this.ownerMenu.options(this.currentOwner);
    const connected = this.context.value?.gateway.snapshot.phase === "connected";
    const views = resolveSessionSettingsActions({
      session: this.session,
      row: this.row,
      groups: this.groups,
      currentOwner: this.currentOwner,
      owners: { options: owners.owners, loading: this.ownerMenu.loading },
      archiveAllowed: this.archiveAllowed,
      disabledReasons: this.actionDisabledReasons,
      connected,
      promotionCheck: this.promotionCheck,
      dispatch: (action) => this.onAction(action),
    });
    return html`<ul class="session-settings__actions">
      ${views.map((view) => {
        const id = `${this.sheetId}-action-${view.id}`;
        const disabled = Boolean(view.disabledReason);
        const reasonId = view.disabledReason || view.note ? `${id}-note` : undefined;
        return html`<li class="session-settings__action" data-action=${view.id}>
          ${
            view.control
              ? html`<label class="session-settings__action-label" for=${id}>${view.label}</label>
                  ${view.control(id, disabled)}`
              : html`<button
                  id=${id}
                  type="button"
                  class=${`btn btn--sm${view.primary ? " primary" : ""} session-settings__action-button`}
                  ?disabled=${disabled}
                  aria-describedby=${reasonId ?? nothing}
                  @click=${() => {
                    if (!disabled) {
                      if (view.closesSheet) {
                        this.onClose();
                      }
                      view.run?.();
                    }
                  }}
                >
                  ${view.label}
                </button>`
          }
          ${
            reasonId
              ? html`<span id=${reasonId} class="session-settings__muted"
                  >${view.disabledReason ?? view.note}</span
                >`
              : nothing
          }
        </li>`;
      })}
    </ul>`;
  }

  private renderSectionBody(section: SessionSettingsSectionId) {
    const row = this.row;
    switch (section) {
      case "identity":
        return renderIdentitySection(row, this.session);
      case "class":
        return renderClassSection(this.session, this.capabilityLabel);
      case "lineage":
        return renderLineageSection({
          row,
          parentLabel: this.parentLabel(),
          children: this.loads.children,
          onRetry: this.retry("children"),
        });
      case "permissions":
        return renderPermissionsSection({
          session: this.session,
          tools: this.loads.tools,
          onRetry: this.retry("tools"),
        });
      case "models":
        return renderModelsSection({
          row,
          usage: this.loads.usage,
          modelRow: this.loads.modelRow,
          onRetry: this.retry("usage"),
          onRetryModelRow: this.retry("modelRow"),
        });
      case "usage":
        return renderUsageSection(row);
      case "activity":
        return renderActivitySection({
          row,
          processes: this.loads.processes,
          automations: this.loads.automations,
          onRetryProcesses: this.retry("processes"),
          onRetryAutomations: this.retry("automations"),
        });
      case "dashboard":
        return renderDashboardSection({
          row,
          board: this.loads.board,
          onRetry: this.retry("board"),
        });
      case "actions":
        return this.renderActions();
      default:
        return section satisfies never;
    }
  }

  private readonly setReturnFocus = (element: Element | undefined) => {
    (element as OpenClawModalDialog | undefined)?.setReturnFocusTarget(this.returnFocus);
  };

  // The host only anchors state and context; the sheet renders in a body-level portal, so pane
  // handlers (Escape and outside-tap closing of open <details>, printable-key focus) and pane
  // stacking never reach it.
  override render() {
    return nothing;
  }

  private renderSheet() {
    const title = t("chat.sessionSettings.title");
    const titleId = `${this.sheetId}-title`;
    return html`<openclaw-modal-dialog
      class="drawer drawer--floating session-settings-dialog"
      label=${title}
      description=${this.session.label}
      ${ref(this.setReturnFocus)}
      @modal-cancel=${() => this.onClose()}
    >
      <div class="session-settings" aria-labelledby=${titleId}>
        <header class="session-settings__header">
          <div class="session-settings__title">
            <h2 id=${titleId}>${title}</h2>
            <span class="session-settings__subtitle">${this.session.label}</span>
          </div>
          <!-- No title: it would open a tooltip on the initial focus that eats the first Escape. -->
          <button
            type="button"
            class="btn btn--ghost btn--icon session-settings__close"
            aria-label=${t("chat.sessionSettings.close")}
            ?autofocus=${!this.initialSection}
            @click=${() => this.onClose()}
          >
            ${icons.x}
          </button>
        </header>
        <div class="session-settings__body">
          ${SESSION_SETTINGS_SECTIONS.map(
            (section) => html`<details
              class="session-settings__section"
              data-section=${section}
              ?open=${this.expanded.has(section)}
              @toggle=${(event: Event) => this.toggleSection(section, event)}
            >
              <summary
                class="session-settings__summary"
                ?autofocus=${section === this.initialSection}
              >
                ${t(`chat.sessionSettings.section.${section}`)}
              </summary>
              <div class="session-settings__content">
                ${this.expanded.has(section) ? this.renderSectionBody(section) : nothing}
              </div>
            </details>`,
          )}
        </div>
      </div>
    </openclaw-modal-dialog>`;
  }
}

if (!customElements.get("openclaw-session-settings-sheet")) {
  customElements.define("openclaw-session-settings-sheet", SessionSettingsSheet);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-settings-sheet": SessionSettingsSheet;
  }
}
