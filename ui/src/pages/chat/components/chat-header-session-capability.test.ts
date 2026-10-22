/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
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

async function mountMenu(
  session: Partial<SessionMenuData>,
  onAction: (action: unknown) => void = () => {},
): Promise<HeaderMenuElement> {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  render(
    html`<openclaw-chat-header-session-menu
      .session=${{ ...EMPTY_SESSION_MENU_DATA, label: "Test session", ...session }}
      .onAction=${onAction}
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
    const live = menu.querySelector('[role="status"]')!;
    return {
      glyph: status.querySelector('[aria-hidden="true"]')?.textContent?.trim(),
      name: status.getAttribute("aria-label"),
      title: status.getAttribute("title"),
      tag: status.tagName,
      announced: live.textContent?.trim(),
      live: live.getAttribute("aria-live"),
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
      tag: "BUTTON",
      announced: name,
      live: "polite",
    });
    // The words travel with the glyph: its name, tooltip and the live announcement.
    expect(menu.querySelector(".session-capability-status")?.textContent).toContain(name);
  }
});

const facts = (menu: HeaderMenuElement) =>
  Object.fromEntries(
    [...menu.querySelectorAll(".session-capability-details__facts dt")].map((term) => [
      term.textContent?.trim(),
      [
        ...(term.nextElementSibling?.querySelectorAll("li").length
          ? term.nextElementSibling.querySelectorAll("li")
          : [term.nextElementSibling!]),
      ].map((node) => node.textContent?.replace(/\s+/g, " ").trim()),
    ]),
  );
const bubbleButtons = (menu: HeaderMenuElement) =>
  [
    ...menu.querySelectorAll<HTMLButtonElement>(
      ".session-capability-details [data-promotion-action]",
    ),
  ].map((button) => ({
    kind: button.dataset.promotionAction,
    label: button.textContent?.trim(),
    disabled: button.disabled,
  }));

it("makes the capability glyph itself the keyboard-operable info button; no separate ⓘ", async () => {
  const menu = await mountMenu({ key: "k", sessionId: "s", capabilityStatus: promotionStatus });
  const toggle = menu.querySelector<HTMLButtonElement>("button.session-capability-details-toggle")!;
  const panel = menu.querySelector<HTMLElement>(".session-capability-details")!;
  expect(menu.querySelectorAll("button.session-capability-details-toggle")).toHaveLength(1);
  expect(toggle.classList.contains("session-capability-status")).toBe(true);
  expect(toggle.getAttribute("aria-label")).toBe("Delegated · limited");
  expect(toggle.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe("🔒");
  expect(toggle.querySelector("svg")).toBeNull();
  expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);

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

  // A tap elsewhere closes it (phones have no Escape key); a tap inside does not.
  toggle.click();
  await menu.updateComplete;
  panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  await menu.updateComplete;
  expect(panel.hidden).toBe(false);
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  await menu.updateComplete;
  expect(panel.hidden).toBe(true);
});

it("shows a standard session as type and permissions only, with no promote button", async () => {
  const menu = await mountMenu({
    key: "k",
    sessionId: "s",
    capabilityStatus: {
      ...promotionStatus,
      historicalOrigin: "ordinary",
      effectiveClass: "ordinary",
      classScope: "all-turns",
      canPromote: false,
      disabledReasons: ["unsupported-target:not-delegated"],
      effectiveRestrictions: ["current-role-grants-resource-policy-and-sandbox-still-apply"],
      capabilities: { sessionsSend: "unknown" },
    },
  });
  expect(facts(menu)).toEqual({
    Type: ["Standard"],
    Permissions: [
      "Standard: every turn",
      "Your role, resource policy and sandbox still apply",
      "Session messaging: checked when used",
    ],
  });
  expect(bubbleButtons(menu)).toEqual([]);
});

it("offers Promote on a delegated session through the same action as the menu", async () => {
  const onAction = vi.fn();
  const menu = await mountMenu(
    { key: "k", sessionId: "s", capabilityStatus: promotionProjection("authorized-none") },
    onAction,
  );
  menu.querySelector<HTMLButtonElement>(".session-capability-details-toggle")!.click();
  await menu.updateComplete;
  expect(facts(menu)).toEqual({
    Type: ["Limited (delegated)"],
    Permissions: [
      "Delegated limits: every turn",
      "Your role, resource policy and sandbox still apply",
      "Session messaging: checked when used",
    ],
  });
  expect(bubbleButtons(menu)).toEqual([
    { kind: "promote-session", label: "Promote", disabled: false },
  ]);
  menu.querySelector<HTMLButtonElement>('[data-promotion-action="promote-session"]')!.click();
  await menu.updateComplete;
  expect(onAction).toHaveBeenCalledWith({ kind: "promote-session" });
  // The confirm dialog takes over; the bubble does not linger behind it.
  expect(menu.querySelector<HTMLElement>(".session-capability-details")!.hidden).toBe(true);
});

it("disables Promote with a short reason when this viewer may not promote", async () => {
  const onAction = vi.fn();
  const menu = await mountMenu(
    { key: "k", sessionId: "s", capabilityStatus: promotionProjection("restricted-viewer") },
    onAction,
  );
  expect(facts(menu)["Why not"]).toEqual(["Needs your current authorization"]);
  expect(bubbleButtons(menu)).toEqual([
    { kind: "promote-session", label: "Promote", disabled: true },
  ]);
  menu.querySelector<HTMLButtonElement>('[data-promotion-action="promote-session"]')!.click();
  expect(onAction).not.toHaveBeenCalled();
});

it("shows a pending promotion's blocker and offers Cancel only to a viewer who may cancel", async () => {
  const onAction = vi.fn();
  const menu = await mountMenu(
    { key: "k", sessionId: "s", capabilityStatus: promotionProjection("authorized-pending") },
    onAction,
  );
  expect(facts(menu)).toEqual({
    Type: ["Pending promotion"],
    Permissions: [
      "Delegated limits: every turn",
      "Your role, resource policy and sandbox still apply",
      "Session messaging: checked when used",
    ],
    Status: [
      "Starts on the next fresh turn",
      "Waiting for running work to settle and an access re-check",
    ],
  });
  expect(bubbleButtons(menu)).toEqual([
    { kind: "cancel-promotion", label: "Cancel promotion", disabled: false },
  ]);
  menu.querySelector<HTMLButtonElement>('[data-promotion-action="cancel-promotion"]')!.click();
  expect(onAction).toHaveBeenCalledWith({ kind: "cancel-promotion" });

  menu.session = { ...menu.session, capabilityStatus: promotionProjection("unauthorized-pending") };
  await menu.updateComplete;
  expect(bubbleButtons(menu)).toEqual([]);
  expect(facts(menu).Status?.[0]).toBe("Starts on the next fresh turn");
  expect(facts(menu)["Why not"]).toEqual(["Needs your current authorization"]);
});

it("keeps an unknown Gateway code verbatim and offers a status check when the result is unknown", async () => {
  const onAction = vi.fn();
  const menu = await mountMenu(
    {
      key: "k",
      sessionId: "s",
      promotionUncertain: true,
      capabilityStatus: {
        ...promotionProjection("authorized-none"),
        canPromote: false,
        disabledReasons: ["some-future-reason"],
      },
    },
    onAction,
  );
  expect(facts(menu)["Why not"]).toEqual(["some-future-reason"]);
  expect(facts(menu).Status).toEqual(["Promotion result unknown · check status"]);
  expect(bubbleButtons(menu)).toEqual([
    { kind: "promote-session", label: "Promote", disabled: true },
    { kind: "check-promotion", label: "Check status", disabled: false },
  ]);
  menu.querySelector<HTMLButtonElement>('[data-promotion-action="check-promotion"]')!.click();
  expect(onAction).toHaveBeenCalledWith({ kind: "check-promotion" });
});

it("lists Check promotion status only for a session with a promotion record or request", async () => {
  const menu = await mountMenu({ key: "k", sessionId: "s" });
  const promotionItems = async (session: Partial<SessionMenuData>) => {
    menu.session = {
      ...menu.session,
      capabilityStatus: undefined,
      promotionBusy: false,
      promotionUncertain: false,
      ...session,
    };
    await menu.updateComplete;
    return [...menu.querySelectorAll("wa-dropdown-item.session-promotion-action")].map((item) =>
      item.getAttribute("value"),
    );
  };
  const standard = {
    ...promotionStatus,
    historicalOrigin: "ordinary",
    effectiveClass: "ordinary",
    classScope: "all-turns",
    canPromote: false,
    disabledReasons: ["unsupported-target:not-delegated"],
  } satisfies NonNullable<SessionMenuData["capabilityStatus"]>;
  // Ordinary sessions without a promotion record show nothing promotion-related.
  expect(await promotionItems({})).toEqual([]);
  expect(await promotionItems({ capabilityStatus: standard })).toEqual([]);
  expect(menu.textContent).not.toContain("Check promotion status");
  expect(
    await promotionItems({ capabilityStatus: promotionProjection("authorized-none") }),
  ).toEqual(["promote-session", "check-promotion"]);
  expect(
    await promotionItems({ capabilityStatus: promotionProjection("promoted-requester") }),
  ).toEqual(["check-promotion"]);
  expect(
    await promotionItems({ capabilityStatus: { ...standard, promotionState: "revoked" } }),
  ).toEqual(["check-promotion"]);
  expect(await promotionItems({ capabilityStatus: standard, promotionUncertain: true })).toEqual([
    "check-promotion",
  ]);
  expect(await promotionItems({ capabilityStatus: standard, promotionBusy: true })).toEqual([
    "check-promotion",
  ]);
});
