/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import {
  EMPTY_SESSION_MENU_DATA,
  type SessionMenuData,
} from "../../../components/session-menu-actions.ts";
import { promotionProjection } from "../../../lib/sessions/session-promotion.test-support.ts";
import "./chat-header-session-menu.ts";
import { capabilityCodeLabel } from "./session-capability-info.ts";

type HeaderMenuElement = HTMLElementTagNameMap["openclaw-chat-header-session-menu"];

const containers: HTMLElement[] = [];

const promotionStatus = {
  ...promotionProjection("authorized-none"),
  lifecycleRevision: "rev-1",
  effectiveRestrictions: ["inherited-limit"],
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

/** The glyph opens the Session settings sheet; its Class section holds the old bubble's facts. */
async function openSettings(menu: HeaderMenuElement) {
  menu.querySelector<HTMLButtonElement>(".session-capability-details-toggle")!.click();
  await menu.updateComplete;
  const sheet = menu.querySelector("openclaw-session-settings-sheet")!;
  await sheet.updateComplete;
  return sheet;
}

/** The open sheet renders in a body-level portal, outside the header. */
const sheetContent = (menu: HeaderMenuElement): ParentNode =>
  menu.querySelector("openclaw-session-settings-sheet")?.content ??
  document.createDocumentFragment();

const facts = (menu: HeaderMenuElement) =>
  Object.fromEntries(
    [
      ...sheetContent(menu).querySelectorAll('[data-section="class"] .session-settings__facts dt'),
    ].map((term) => [
      term.textContent?.trim(),
      [
        ...(term.nextElementSibling?.querySelectorAll("li").length
          ? term.nextElementSibling.querySelectorAll("li")
          : [term.nextElementSibling!]),
      ].map((node) => node.textContent?.replace(/\s+/g, " ").trim()),
    ]),
  );
const promotionButtons = (menu: HeaderMenuElement) =>
  [
    ...sheetContent(menu).querySelectorAll<HTMLButtonElement>(
      ':is([data-action="promotion"], [data-action="check-promotion"]) button',
    ),
  ].map((button) => ({
    action: button.closest("[data-action]")?.getAttribute("data-action"),
    label: button.textContent?.trim(),
    disabled: button.disabled,
  }));

it("makes the capability glyph itself the keyboard-operable entry to Session settings", async () => {
  const menu = await mountMenu({ key: "k", sessionId: "s", capabilityStatus: promotionStatus });
  const toggle = menu.querySelector<HTMLButtonElement>("button.session-capability-details-toggle")!;
  expect(menu.querySelectorAll("button.session-capability-details-toggle")).toHaveLength(1);
  expect(toggle.classList.contains("session-capability-status")).toBe(true);
  expect(toggle.getAttribute("aria-label")).toBe("Delegated · limited");
  expect(toggle.getAttribute("aria-haspopup")).toBe("dialog");
  expect(toggle.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe("🔒");
  expect(toggle.querySelector("svg")).toBeNull();
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();

  const sheet = await openSettings(menu);
  const dialog = sheet.content!.querySelector("openclaw-modal-dialog")!;
  expect(dialog.getAttribute("label")).toBe("Session settings");
  expect(sheet.returnFocus).toBe(toggle);
  // The dialog's cancel (Escape or a tap outside) closes the sheet.
  dialog.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true, composed: true }));
  await menu.updateComplete;
  await sheet.updateComplete;
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
});

it("opens Session settings from the header menu item, returning focus to the menu trigger", async () => {
  const menu = await mountMenu({ key: "k", sessionId: "s", capabilityStatus: promotionStatus });
  const item = menu.querySelector<HTMLElement>('wa-dropdown-item[value="session-settings"]')!;
  expect(item.textContent?.trim()).toBe("Session settings…");
  menu.querySelector("wa-dropdown")!.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      cancelable: true,
      detail: { item: { value: "session-settings" } },
    }),
  );
  await menu.updateComplete;
  const sheet = menu.querySelector("openclaw-session-settings-sheet")!;
  await sheet.updateComplete;
  expect(sheet.open).toBe(true);
  expect(sheet.returnFocus).toBe(menu.querySelector(".chat-header-session-menu__trigger"));
});

it("shows a standard session's class as type and turns only, with no promote action", async () => {
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
      effectiveRestrictions: [],
      capabilities: { sessionsSend: "unknown" },
    },
  });
  await openSettings(menu);
  expect(facts(menu)).toEqual({ Type: ["Standard"], Turns: ["Standard: every turn"] });
  expect(promotionButtons(menu)).toEqual([]);
});

it("shows a detached promotion as Standard with where and when it was promoted from", async () => {
  const status = promotionProjection("promoted-detached");
  const menu = await mountMenu({
    key: "k",
    sessionId: "s",
    capabilityStatus: status,
    promotedFromLabel: "Parent board",
  });
  await openSettings(menu);
  const date = new Date(status.promotedFrom!.at).toLocaleDateString();
  expect(facts(menu)).toEqual({
    Type: ["Standard"],
    Origin: [`Promoted from Parent board on ${date}`],
    Turns: ["Standard: every turn"],
    Status: ["Promoted"],
  });
  expect(promotionButtons(menu)).toEqual([]);
  menu.session = { ...menu.session, promotedFromLabel: undefined };
  await menu.updateComplete;
  await menu.querySelector("openclaw-session-settings-sheet")!.updateComplete;
  expect(facts(menu).Origin).toEqual([`Promoted on ${date}`]);
});

it("offers Promote on a delegated session through the same action as the menu", async () => {
  const onAction = vi.fn();
  const menu = await mountMenu(
    { key: "k", sessionId: "s", capabilityStatus: promotionProjection("authorized-none") },
    onAction,
  );
  await openSettings(menu);
  expect(facts(menu)).toEqual({
    Type: ["Limited (delegated)"],
    Turns: ["Delegated limits: every turn"],
  });
  expect(promotionButtons(menu)).toEqual([
    { action: "promotion", label: "Promote to ordinary session…", disabled: false },
  ]);
  sheetContent(menu).querySelector<HTMLButtonElement>('[data-action="promotion"] button')!.click();
  await menu.updateComplete;
  expect(onAction).toHaveBeenCalledWith({ kind: "promote-session" });
  // The confirm dialog takes over; the sheet does not linger behind it.
  expect(menu.querySelector("openclaw-session-settings-sheet")!.open).toBe(false);
});

it("disables Promote with a short reason when this viewer may not promote", async () => {
  const onAction = vi.fn();
  const menu = await mountMenu(
    { key: "k", sessionId: "s", capabilityStatus: promotionProjection("restricted-viewer") },
    onAction,
  );
  await openSettings(menu);
  expect(facts(menu)["Why not"]).toEqual(["Needs your current authorization"]);
  expect(promotionButtons(menu)).toEqual([
    { action: "promotion", label: "Promote to ordinary session…", disabled: true },
  ]);
  sheetContent(menu).querySelector<HTMLButtonElement>('[data-action="promotion"] button')!.click();
  expect(onAction).not.toHaveBeenCalled();
});

it("shows a pending promotion's blocker and enables Cancel only for a viewer who may cancel", async () => {
  const onAction = vi.fn();
  const menu = await mountMenu(
    { key: "k", sessionId: "s", capabilityStatus: promotionProjection("authorized-pending") },
    onAction,
  );
  await openSettings(menu);
  expect(facts(menu)).toEqual({
    Type: ["Pending promotion"],
    Turns: ["Delegated limits: every turn"],
    Status: [
      "Starts on the next fresh turn",
      "Waiting for running work to settle and an access re-check",
    ],
  });
  expect(promotionButtons(menu)).toEqual([
    { action: "promotion", label: "Cancel pending promotion…", disabled: false },
  ]);
  sheetContent(menu).querySelector<HTMLButtonElement>('[data-action="promotion"] button')!.click();
  expect(onAction).toHaveBeenCalledWith({ kind: "cancel-promotion" });

  menu.session = { ...menu.session, capabilityStatus: promotionProjection("unauthorized-pending") };
  await openSettings(menu);
  expect(promotionButtons(menu)).toEqual([
    { action: "promotion", label: "Cancel pending promotion…", disabled: true },
  ]);
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
  await openSettings(menu);
  expect(facts(menu)["Why not"]).toEqual(["some-future-reason"]);
  expect(facts(menu).Status).toEqual(["Promotion result unknown · check status"]);
  expect(promotionButtons(menu)).toEqual([
    { action: "promotion", label: "Promote to ordinary session…", disabled: true },
    { action: "check-promotion", label: "Check promotion status", disabled: false },
  ]);
  sheetContent(menu)
    .querySelector<HTMLButtonElement>('[data-action="check-promotion"] button')!
    .click();
  expect(onAction).toHaveBeenCalledWith({ kind: "check-promotion" });
});

it("maps the Gateway's restriction origins to plain words", () => {
  expect(
    ["inherited-limit", "subagent-layer", "agent-policy", "role", "sandbox", "other"].map(
      capabilityCodeLabel,
    ),
  ).toEqual([
    "Some tools limited by its parent",
    "Standard sub-agent limits",
    "Some tools limited by agent policy",
    "Some tools limited by your role",
    "Some tools limited by the sandbox",
    "Some tools limited by other policy",
  ]);
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
