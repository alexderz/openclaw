import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { registerSessionPromotionEnglish } from "../i18n/locales/en-session-promotion.ts";
import {
  canRequestPromotion,
  pendingCancelRequestId,
} from "../lib/sessions/session-promotion-gate.ts";
import type { SessionMenuData } from "./session-menu-actions.ts";

registerSessionPromotionEnglish();

export type PromotionMenuActionKind = "promote-session" | "cancel-promotion" | "check-promotion";

export const PROMOTION_MENU_ACTIONS: readonly PromotionMenuActionKind[] = [
  "promote-session",
  "cancel-promotion",
  "check-promotion",
];

export function isPromotionMenuAction(value: string): value is PromotionMenuActionKind {
  return (PROMOTION_MENU_ACTIONS as readonly string[]).includes(value);
}

/**
 * A promotion record or offer exists: a delegated origin, a lifecycle other than none, or a
 * local request still busy or in doubt. An ordinary session without one shows nothing.
 */
export function hasPromotionContext(session: SessionMenuData): boolean {
  const status = session.capabilityStatus;
  return Boolean(
    session.promotionBusy ||
    session.promotionUncertain ||
    status?.historicalOrigin === "delegated" ||
    (status?.promotionState && status.promotionState !== "none"),
  );
}

/** The one gate for every promotion menu item and info bubble button. */
export function promotionActionAllowed(
  session: SessionMenuData,
  kind: PromotionMenuActionKind,
): boolean {
  const status = session.capabilityStatus;
  return Boolean(
    !session.promotionBusy &&
    !session.promotionDisabledReason &&
    (kind === "check-promotion"
      ? hasPromotionContext(session)
      : session.key &&
        session.sessionId &&
        !session.promotionUncertain &&
        (kind === "cancel-promotion"
          ? pendingCancelRequestId(status)
          : canRequestPromotion(status))),
  );
}

/**
 * Promote (or Cancel while pending) for a delegated or limited session, disabled with the reason
 * when this viewer may not act; `includeCheck` adds the read-only status check.
 */
export function renderPromotionMenuItems(
  session: SessionMenuData,
  options: { includeCheck: boolean },
) {
  const status = session.capabilityStatus;
  const pending = status?.promotionState === "pending";
  const identified = Boolean(session.key && session.sessionId);
  const unavailableReason = pending
    ? !identified || !pendingCancelRequestId(status)
      ? t("chat.sessionHeader.promotion.cancelUnavailable")
      : undefined
    : status?.disabledReasons.join("; ") ||
      (!identified || !canRequestPromotion(status)
        ? t("chat.sessionHeader.promotion.unavailable")
        : undefined);
  const reason =
    session.promotionDisabledReason ??
    (session.promotionBusy ? t("chat.sessionHeader.promotion.busy") : unavailableReason);
  return html`
    ${
      // No capability status is no promotion offer: an unknown session shows no disabled item.
      (status && status.effectiveClass !== "ordinary") || pending
        ? html`
            <wa-dropdown-item
              class="session-menu__item session-promotion-action"
              value=${pending ? "cancel-promotion" : "promote-session"}
              ?disabled=${Boolean(reason) || Boolean(session.promotionUncertain)}
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
    ${
      options.includeCheck && hasPromotionContext(session)
        ? html`<wa-dropdown-item
            class="session-menu__item session-promotion-action"
            value="check-promotion"
            ?disabled=${Boolean(session.promotionBusy || session.promotionDisabledReason)}
          >
            <span class="session-menu__text">${t("chat.sessionHeader.promotion.check")}</span>
          </wa-dropdown-item>`
        : nothing
    }
  `;
}
