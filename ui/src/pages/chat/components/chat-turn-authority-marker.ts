import WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { syncPopoverLabel } from "../../../components/web-awesome-popover.ts";
import { t } from "../../../i18n/index.ts";
import { registerSessionSettingsEnglish } from "../../../i18n/locales/en-session-settings.ts";
import { readTurnAuthorityClass } from "../../../lib/chat/turn-authority.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import "../../../styles/chat/turn-authority.css";

registerSessionSettingsEnglish();

/** What the pane lends the marker: the session's headline now and the way to Permissions. */
export type TurnAuthorityHost = {
  /** The session's Permissions headline, worded as the Session settings sheet words it. */
  readPermissionsHeadline: () => Promise<string>;
  /** Opens Session settings at Permissions; false where this surface has no sheet to open. */
  openPermissions: (returnFocus: HTMLElement) => boolean;
};

let markerIds = 0;

function nextMarkerId() {
  markerIds += 1;
  return `chat-turn-authority-${markerIds}`;
}

/**
 * The quiet "!" on a user turn stamped `delegated`. Its popover says what the turn ran with, then
 * the session's Permissions headline as it is now (it may have been promoted since), and a way to
 * the full section; it informs and offers no promotion of its own. The popover mounts on first
 * activation, so a long delegated transcript renders plain buttons.
 */
class ChatTurnAuthorityMarker extends OpenClawLightDomElement {
  @property({ attribute: false }) host: TurnAuthorityHost | null = null;
  @state() private armed = false;
  @state() private headline: string | null = null;
  private readonly triggerId = nextMarkerId();
  private headlineRequest = 0;

  private get popoverElement() {
    return this.querySelector<WaPopover>("wa-popover");
  }

  private readonly arm = async () => {
    if (this.armed) {
      // Once mounted, the popover owns its trigger's clicks.
      return;
    }
    this.armed = true;
    await this.updateComplete;
    const popover = this.popoverElement;
    if (popover) {
      popover.open = true;
    }
  };

  private readonly handleShow = (event: Event) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    this.querySelector(`#${this.triggerId}`)?.setAttribute("aria-expanded", "true");
    const host = this.host;
    if (!host) {
      return;
    }
    const request = (this.headlineRequest += 1);
    void host.readPermissionsHeadline().then(
      (headline) => {
        if (request === this.headlineRequest) {
          this.headline = headline;
        }
      },
      () => {
        if (request === this.headlineRequest) {
          this.headline = t("chat.sessionSettings.permissions.notChecked");
        }
      },
    );
  };

  private readonly handleHide = (event: Event) => {
    if (event.target === event.currentTarget) {
      this.querySelector(`#${this.triggerId}`)?.setAttribute("aria-expanded", "false");
    }
  };

  private readonly openSettings = () => {
    const trigger = this.querySelector<HTMLElement>(`#${this.triggerId}`);
    if (!trigger || !this.host?.openPermissions(trigger)) {
      return;
    }
    const popover = this.popoverElement;
    if (popover) {
      popover.open = false;
    }
  };

  private renderPopover(label: string) {
    const host = this.host;
    return html`<wa-popover
      class="chat-turn-authority__popover"
      for=${this.triggerId}
      placement="bottom-start"
      distance="6"
      without-arrow
      aria-label=${label}
      ${ref(syncPopoverLabel)}
      @wa-show=${this.handleShow}
      @wa-hide=${this.handleHide}
    >
      <div class="chat-turn-authority__panel">
        <p class="chat-turn-authority__turn">${t("chat.sessionSettings.delegatedTurn.turn")}</p>
        ${
          host
            ? html`<p class="chat-turn-authority__headline" role="status">
                  ${t("chat.sessionSettings.delegatedTurn.now", {
                    headline: this.headline ?? t("chat.sessionSettings.permissions.checking"),
                  })}
                </p>
                <button class="chat-turn-authority__link" type="button" @click=${this.openSettings}>
                  ${t("chat.sessionSettings.delegatedTurn.open")}
                </button>`
            : nothing
        }
      </div>
    </wa-popover>`;
  }

  override render() {
    const label = t("chat.sessionSettings.delegatedTurn.label");
    return html`<button
        id=${this.triggerId}
        class="chat-turn-authority__trigger"
        type="button"
        aria-label=${label}
        title=${label}
        aria-haspopup="dialog"
        aria-expanded="false"
        @click=${this.arm}
      >
        <span class="chat-turn-authority__glyph" aria-hidden="true">!</span></button
      >${this.armed ? this.renderPopover(label) : nothing}`;
  }
}

if (!customElements.get("openclaw-chat-turn-authority-marker")) {
  customElements.define("openclaw-chat-turn-authority-marker", ChatTurnAuthorityMarker);
}

/** The marker for a user turn stamped `delegated`; ordinary and unstamped turns show nothing. */
export function renderTurnAuthorityMarker(message: unknown, host: TurnAuthorityHost | undefined) {
  if (readTurnAuthorityClass(message) !== "delegated") {
    return nothing;
  }
  return html`<openclaw-chat-turn-authority-marker
    class="chat-turn-authority"
    .host=${host ?? null}
  ></openclaw-chat-turn-authority-marker>`;
}
