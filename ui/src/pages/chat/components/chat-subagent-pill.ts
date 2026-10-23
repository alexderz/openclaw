import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../../../components/icons.ts";
import { renderThemeBrandIcon } from "../../../components/theme-brand-icon.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import type { ChatSubagentActivity } from "../chat-subagent-wait.ts";
import "./chat-subagent-activity-live.ts";
import "./chat-subagent-pill.css";

/** A gap between roster events must not make the pill blink or its count dip. */
export const SUBAGENT_PILL_HOLD_MS = 2_000;

let pillSequence = 0;

// Every chat render projects a fresh array; only what the rows show is a change.
function rowsSignature(rows: readonly ChatSubagentActivity[]): string {
  return JSON.stringify(
    rows.map(({ session, ...display }) => [
      display,
      session.sessionId,
      session.lifecycleRevision,
      session.agentId,
      session.activeRunIds,
      session.observerDigest,
    ]),
  );
}

/**
 * Running subagents as one count directly above the composer input. It reads the
 * rows the transcript once rendered inline, so its place never depends on the
 * message list.
 */
export class ChatSubagentPill extends OpenClawLightDomContentsElement {
  @property({
    attribute: false,
    hasChanged: (
      next: readonly ChatSubagentActivity[],
      previous?: readonly ChatSubagentActivity[],
    ) => !previous || rowsSignature(next) !== rowsSignature(previous),
  })
  rows: readonly ChatSubagentActivity[] = [];
  /** A different session starts fresh: no held rows and a closed list. */
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) onOpenSubagent?: (key: string) => void;
  @property({ attribute: false }) onOpenSession?: (key: string) => void;
  /** Opens the Subagents panel, which also stops them; absent when it cannot list them all. */
  @property({ attribute: false }) onOpenSubagents?: () => void;

  @state() private shown: readonly ChatSubagentActivity[] = [];
  @state() private open = false;
  /** Rows that left the roster, kept until their own hold ends. */
  private departed = new Map<string, { row: ChatSubagentActivity; at: number }>();
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdExpired = false;
  private shownSessionKey: string | null = null;
  private readonly sheetId: string;

  constructor() {
    super();
    pillSequence += 1;
    this.sheetId = `chat-subagent-pill-sheet-${pillSequence}`;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.clearHold();
    // A remount shows the roster as it is then, not a hold from before.
    this.shownSessionKey = null;
    super.disconnectedCallback();
  }

  private clearHold(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.departed.clear();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const expired = this.holdExpired;
    this.holdExpired = false;
    if (this.shownSessionKey !== this.sessionKey) {
      this.clearHold();
      this.shownSessionKey = this.sessionKey;
      this.shown = this.rows;
      this.open = false;
    } else if (changed.has("rows") || expired) {
      this.reconcile();
    }
    if (!this.shown.length) {
      this.open = false;
    }
  }

  // The count rises at once and drops only after a row has been gone for the
  // whole hold; held rows never lift it above what was already shown.
  private reconcile(): void {
    const now = Date.now();
    const current = new Set(this.rows.map((row) => row.key));
    for (const row of this.shown) {
      if (!current.has(row.key) && !this.departed.has(row.key)) {
        this.departed.set(row.key, { row, at: now });
      }
    }
    for (const [key, { at }] of this.departed) {
      if (current.has(key) || now - at >= SUBAGENT_PILL_HOLD_MS) {
        this.departed.delete(key);
      }
    }
    const room = Math.max(0, this.shown.length - this.rows.length);
    const held = [...this.departed.values()].slice(0, room);
    this.shown = [...this.rows, ...held.map(({ row }) => row)];
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (held.length && this.isConnected) {
      const next = Math.min(...held.map(({ at }) => at + SUBAGENT_PILL_HOLD_MS));
      this.holdTimer = setTimeout(
        () => {
          this.holdTimer = null;
          this.holdExpired = true;
          this.requestUpdate();
        },
        Math.max(0, next - now),
      );
    }
  }

  private readonly toggle = (): void => {
    this.open = !this.open;
  };

  private readonly closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.open && !event.defaultPrevented) {
      event.preventDefault();
      this.open = false;
      this.querySelector<HTMLButtonElement>(".chat-subagent-pill__toggle")?.focus();
    }
  };

  // Opening a subagent leaves the list; the pill stays for the rest.
  private readonly openSubagent = (key: string): void => {
    this.open = false;
    this.onOpenSubagent?.(key);
  };

  private readonly openSession = (key: string): void => {
    this.open = false;
    this.onOpenSession?.(key);
  };

  private readonly openSubagents = (): void => {
    this.open = false;
    this.onOpenSubagents?.();
  };

  override render() {
    const rows = this.shown;
    if (!rows.length) {
      return nothing;
    }
    const running = rows.some((row) => row.status === "running");
    const label =
      rows.length === 1
        ? t("chat.subagentsPanel.pillOne")
        : t("chat.subagentsPanel.pillMany", { count: String(rows.length) });
    return html`<div
      class="chat-subagent-pill"
      data-open=${this.open}
      @keydown=${this.closeOnEscape}
    >
      ${
        this.open
          ? html`<div class="chat-subagent-pill__sheet" id=${this.sheetId}>
              <openclaw-chat-subagent-activity
                .rows=${rows}
                .onOpenSubagent=${this.onOpenSubagent ? this.openSubagent : undefined}
                .onOpenSession=${this.onOpenSession ? this.openSession : undefined}
              ></openclaw-chat-subagent-activity>
              ${
                this.onOpenSubagents
                  ? html`<button
                      class="chat-subagent-pill__all"
                      type="button"
                      @click=${this.openSubagents}
                    >
                      ${t("chat.subagentsPanel.showAll")}
                    </button>`
                  : nothing
              }
            </div>`
          : nothing
      }
      <button
        class="chat-subagent-pill__toggle"
        type="button"
        aria-expanded=${this.open}
        aria-controls=${this.open ? this.sheetId : nothing}
        data-count=${rows.length}
        @click=${this.toggle}
      >
        <span class="chat-subagent-pill__chip">
          <span
            class="chat-subagent-pill__icon ${running ? "chat-reading-indicator" : ""}"
            aria-hidden="true"
            >${running ? renderThemeBrandIcon(icons.claw) : icons.clock}</span
          >
          <span class="chat-subagent-pill__label">${label}</span>
          <span class="chat-subagent-pill__chevron" aria-hidden="true">${icons.chevronDown}</span>
        </span>
      </button>
    </div>`;
  }
}

if (!customElements.get("openclaw-chat-subagent-pill")) {
  customElements.define("openclaw-chat-subagent-pill", ChatSubagentPill);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-subagent-pill": ChatSubagentPill;
  }
}
