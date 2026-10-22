import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { registerSessionPromotionEnglish } from "../i18n/locales/en-session-promotion.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

registerSessionPromotionEnglish();

/**
 * The session type tick for a limited or pending-promotion row: a 3px amber bar in the title's
 * leading gutter (no title width), plus the same words as the link's description and tooltip.
 */
export function renderSidebarPromotionTick(
  session: Pick<SidebarRecentSession, "key" | "promotionMark">,
  /** The row's other description ids, in order; the type words follow the run state. */
  [stateId, ...rest]: readonly (string | undefined)[],
) {
  const ids = (id?: string) => [stateId, id, ...rest].filter(Boolean).join(" ");
  if (!session.promotionMark) {
    return { describedBy: ids(), tick: nothing };
  }
  const text = t(`chat.sessionHeader.promotion.sidebar.${session.promotionMark}`);
  const describedById = `sidebar-session-promotion-${encodeURIComponent(session.key)}`;
  return {
    describedBy: ids(describedById),
    tick: html`<span
        class="sidebar-session-promotion-tick sidebar-session-promotion-tick--${session.promotionMark}"
        title=${text}
        aria-hidden="true"
      ></span
      ><span class="sr-only" id=${describedById} aria-hidden="true">${text}</span>`,
  };
}
