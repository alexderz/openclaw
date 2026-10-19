/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, expect, it } from "vitest";
import {
  EMPTY_SESSION_MENU_DATA,
  type SessionMenuData,
} from "../../../components/session-menu-actions.ts";
import { promotionProjection } from "../../../lib/sessions/session-promotion.test-support.ts";
import "./chat-header-session-menu.ts";

type HeaderMenuElement = HTMLElementTagNameMap["openclaw-chat-header-session-menu"];

const containers: HTMLElement[] = [];

const promotionStatus = {
  ...promotionProjection("authorized-none"),
  lifecycleRevision: "rev-1",
  effectiveRestrictions: ["Delegated tools"],
  capabilities: { sessionsSend: "denied" },
} satisfies NonNullable<SessionMenuData["capabilityStatus"]>;

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

async function mountMenu(session: Partial<SessionMenuData>): Promise<HeaderMenuElement> {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  render(
    html`<openclaw-chat-header-session-menu
      .session=${{ ...EMPTY_SESSION_MENU_DATA, label: "Test session", ...session }}
    ></openclaw-chat-header-session-menu>`,
    container,
  );
  const menu = container.querySelector("openclaw-chat-header-session-menu")!;
  await menu.updateComplete;
  return menu;
}

it("compacts the capability badge to one glyph that keeps the full words as its name", async () => {
  const menu = await mountMenu({ key: "k", sessionId: "s" });
  const badge = async (session: Partial<SessionMenuData>) => {
    menu.session = {
      ...menu.session,
      capabilityStatus: undefined,
      promotionBusy: false,
      promotionUncertain: false,
      promotionDenied: false,
      ...session,
    };
    await menu.updateComplete;
    const status = menu.querySelector(".session-capability-status")!;
    return {
      glyph: status.querySelector('[aria-hidden="true"]')?.textContent?.trim(),
      name: status.getAttribute("aria-label"),
      title: status.getAttribute("title"),
      role: status.getAttribute("role"),
      live: status.getAttribute("aria-live"),
    };
  };
  const cases: Array<[Partial<SessionMenuData>, string, string]> = [
    [{ capabilityStatus: promotionProjection("authorized-none") }, "🔒", "Delegated · limited"],
    [
      { capabilityStatus: promotionProjection("promoted-other-viewer") },
      "🔒",
      "Promoted for someone else · your turns limited",
    ],
    [
      { capabilityStatus: promotionProjection("promoted-requester") },
      "👤",
      "Ordinary · your chat turns only",
    ],
    [
      {
        capabilityStatus: {
          ...promotionStatus,
          effectiveClass: "ordinary",
          classScope: "all-turns",
          effectiveRestrictions: [],
          capabilities: { sessionsSend: "allowed" },
        },
      },
      "👤",
      "Ordinary",
    ],
    [{ capabilityStatus: promotionProjection("authorized-pending") }, "⏳", "Promotion pending"],
    [{ promotionBusy: true }, "⏳", "Checking or submitting promotion…"],
    [{}, "⚪", "Capability status unknown"],
    [
      { capabilityStatus: promotionProjection("stale-identity") },
      "⚪",
      "Capability status unknown",
    ],
    [
      { capabilityStatus: promotionProjection("authorized-none"), promotionUncertain: true },
      "⚪",
      "Promotion result unknown · check status",
    ],
    [
      { capabilityStatus: promotionProjection("revoked-authorized") },
      "🔴",
      "Promotion denied · limited",
    ],
    [
      { capabilityStatus: promotionProjection("authorized-none"), promotionDenied: true },
      "🔴",
      "Promotion isn't allowed for this session",
    ],
  ];
  for (const [session, glyph, name] of cases) {
    expect(await badge(session)).toEqual({
      glyph,
      name,
      title: name,
      role: "status",
      live: "polite",
    });
    // The words travel with the glyph: announced by the live region and shown in the details.
    expect(menu.querySelector(".session-capability-status")?.textContent).toContain(name);
    expect(menu.querySelector(".session-capability-details")?.textContent).toContain(name);
  }
});

it("opens the same capability details from an icon-only, keyboard-operable button", async () => {
  const menu = await mountMenu({ key: "k", sessionId: "s", capabilityStatus: promotionStatus });
  const toggle = menu.querySelector<HTMLButtonElement>("button.session-capability-details-toggle")!;
  const panel = menu.querySelector<HTMLElement>(".session-capability-details")!;
  expect(toggle.getAttribute("aria-label")).toBe("Session capability details");
  expect(toggle.getAttribute("title")).toBe("Session capability details");
  // Icon only (the shared ⓘ info icon): the name comes from aria-label, not visible text.
  expect(toggle.textContent?.trim()).toBe("");
  expect(toggle.querySelector("svg")).not.toBeNull();
  expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);
  expect(panel.textContent).toContain("Delegated tools");

  toggle.click();
  await menu.updateComplete;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(panel.hidden).toBe(false);

  toggle.focus();
  toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await menu.updateComplete;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);
  expect(document.activeElement).toBe(toggle);
});
