/* @vitest-environment jsdom */

import { ContextProvider, createContext } from "@lit/context";
import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow, ToolsEffectiveResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { promotionProjection } from "../../lib/sessions/session-promotion.test-support.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { EMPTY_SESSION_MENU_DATA, type SessionMenuData } from "../session-menu-actions.ts";
import { registerSessionSettingsAction } from "./session-settings-actions.ts";
import "./session-settings-sheet.ts";

type Sheet = HTMLElementTagNameMap["openclaw-session-settings-sheet"];

const KEY = "agent:main:dashboard:child";
const STANDARD = [
  "agents_list",
  "automations",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "gateway",
  "message",
  "openclaw",
  "progress_card",
  "session_status",
  "sessions_send",
];

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(html``, container);
    container.remove();
  }
});

function toolsResult(restrictions: ToolsEffectiveResult["restrictions"]): ToolsEffectiveResult {
  return {
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in",
        source: "core",
        tools: ["read", "exec"].map((id) => ({
          id,
          label: id,
          description: "",
          rawDescription: "",
          source: "core" as const,
        })),
      },
    ],
    restrictions,
  };
}

const delegatedTools = toolsResult({
  evaluatedClass: "delegated",
  limitedTools: [
    ...STANDARD.map((id) => ({ id, origins: ["subagent-layer" as const] })),
    { id: "browser", origins: ["inherited-limit"] },
    { id: "sessions_spawn", origins: ["subagent-layer"] },
  ],
  sessionsSend: "denied",
  evaluatedAt: 1,
});

async function mountSheet(options: {
  session?: Partial<SessionMenuData>;
  row?: Partial<GatewaySessionRow>;
  respond?: (method: string, params: Record<string, unknown>) => unknown;
  initialSection?: Sheet["initialSection"];
}) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    const value = options.respond?.(method, params);
    if (value instanceof Error) {
      throw value;
    }
    return value ?? {};
  });
  const fixture = createApplicationGateway();
  fixture.publish({
    ...fixture.gateway.snapshot,
    phase: "connected",
    client: { request } as never,
    hello: null,
  });
  const container = document.createElement("div");
  containers.push(container);
  void new ContextProvider(container, {
    context: createContext<Partial<ApplicationContext>>(applicationContext),
    initialValue: {
      gateway: fixture.gateway,
      sessions: { state: { result: null }, subscribe: () => () => {} } as never,
      agents: { state: { agentsList: null } } as never,
      agentIdentity: { get: () => undefined } as never,
    },
  });
  document.body.append(container);
  const onAction = vi.fn();
  const onClose = vi.fn();
  render(
    html`<openclaw-session-settings-sheet
      .open=${true}
      .row=${{ key: KEY, agentId: "main", sessionId: "s-1", ...options.row } as GatewaySessionRow}
      .session=${{
        ...EMPTY_SESSION_MENU_DATA,
        key: KEY,
        label: "Child session",
        sessionId: "s-1",
        ...options.session,
      }}
      .initialSection=${options.initialSection ?? null}
      .archiveAllowed=${true}
      .onAction=${onAction}
      .onClose=${onClose}
    ></openclaw-session-settings-sheet>`,
    container,
  );
  const sheet = container.querySelector("openclaw-session-settings-sheet")!;
  await sheet.updateComplete;
  await settle(sheet);
  return { sheet, request, onAction, onClose };
}

async function settle(sheet: Sheet) {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await sheet.updateComplete;
  }
}

const section = (sheet: Sheet, id: string) =>
  sheet.content!.querySelector<HTMLDetailsElement>(`details[data-section="${id}"]`)!;
const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/g, " ").trim();

async function openSection(sheet: Sheet, id: string) {
  const details = section(sheet, id);
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await settle(sheet);
}

it("titles the sheet and loads only the sections that are open", async () => {
  const { sheet, request } = await mountSheet({
    session: { capabilityStatus: { ...promotionProjection("authorized-none") } },
    respond: (method) =>
      method === "tools.effective"
        ? delegatedTools
        : method === "sessions.processes.list"
          ? { sessionId: "s-1", processes: [], truncated: false }
          : method === "cron.list"
            ? { jobs: [{ id: "j1", name: "nightly", enabled: true }], total: 1 }
            : undefined,
  });
  const dialog = sheet.content!.querySelector("openclaw-modal-dialog")!;
  expect(dialog.getAttribute("label")).toBe("Session settings");
  expect(text(sheet.content!.querySelector(".session-settings__header h2"))).toBe(
    "Session settings",
  );
  expect(
    [...sheet.content!.querySelectorAll("details[data-section]")].map((details) => [
      details.getAttribute("data-section"),
      (details as HTMLDetailsElement).open,
    ]),
  ).toEqual([
    ["identity", false],
    ["class", true],
    ["lineage", false],
    ["permissions", true],
    ["models", false],
    ["usage", false],
    ["activity", false],
    ["dashboard", false],
    // A delegated session keeps Promote one tap away.
    ["actions", true],
  ]);
  const methods = () =>
    request.mock.calls.map(([method]) => method).filter((method) => method !== "users.list");
  expect(methods()).toEqual(["tools.effective"]);
  // The owner picker reads the directory once.
  expect(request.mock.calls.filter(([method]) => method === "users.list")).toHaveLength(1);
  expect(request).toHaveBeenCalledWith("tools.effective", { sessionKey: KEY, agentId: "main" });

  await openSection(sheet, "activity");
  expect(methods().toSorted()).toEqual(["cron.list", "sessions.processes.list", "tools.effective"]);
  expect(text(section(sheet, "activity").querySelector("dl"))).toContain("0 running · 0 total");
  expect(text(section(sheet, "activity").querySelector("dl"))).toContain("nightly");
  expect(request).toHaveBeenCalledWith(
    "cron.list",
    expect.objectContaining({ sessionKey: KEY, includeDisabled: true }),
  );
  // Reopening a loaded section reads nothing again.
  await openSection(sheet, "permissions");
  expect(methods()).toHaveLength(3);
});

it("shows delegated permissions summary-first: headline, one standard fold, extras by source", async () => {
  const { sheet } = await mountSheet({
    session: { capabilityStatus: promotionProjection("authorized-none") },
    respond: (method) => (method === "tools.effective" ? delegatedTools : undefined),
  });
  const permissions = section(sheet, "permissions");
  expect(text(permissions.querySelector(".session-settings__headline"))).toBe(
    "Delegated · 2 extra limits · can't message other sessions",
  );
  const folds = [...permissions.querySelectorAll<HTMLDetailsElement>(".session-settings__fold")];
  expect(folds.map((fold) => [text(fold.querySelector("summary")), fold.open])).toEqual([
    ["Standard sub-agent limits (11)", false],
    ["Show all 2 tools", false],
  ]);
  expect(
    [...permissions.querySelectorAll(".session-settings__limits")].map((group) => [
      text(group.querySelector("h4")),
      [...group.querySelectorAll("li")].map((item) => text(item)),
    ]),
  ).toEqual([
    ["Inherited from parent", ["browser"]],
    ["Sub-agent layer", ["sessions_spawn"]],
  ]);
});

it("shows an ordinary unrestricted session as one line", async () => {
  const { sheet } = await mountSheet({
    session: {
      capabilityStatus: {
        ...promotionProjection("promoted-detached"),
        capabilities: { sessionsSend: "allowed" },
      },
    },
    respond: (method) =>
      method === "tools.effective"
        ? toolsResult({
            evaluatedClass: "ordinary",
            limitedTools: [],
            sessionsSend: "allowed",
            evaluatedAt: 1,
          })
        : undefined,
  });
  const content = section(sheet, "permissions").querySelector(".session-settings__content")!;
  expect(text(content)).toBe("Full permissions");
  expect(content.querySelectorAll("details, ul, h4")).toHaveLength(0);
});

it("says plainly when permissions could not be checked, and retries on request", async () => {
  let fail = true;
  const { sheet, request } = await mountSheet({
    session: { capabilityStatus: promotionProjection("authorized-none") },
    respond: (method) =>
      method === "tools.effective" ? (fail ? new Error("boom") : delegatedTools) : undefined,
  });
  const permissions = section(sheet, "permissions");
  expect(text(permissions.querySelector(".session-settings__headline"))).toBe(
    "Permissions not checked yet",
  );
  expect(text(permissions.querySelector('[role="alert"]'))).toContain("boom");
  fail = false;
  permissions.querySelector<HTMLButtonElement>(".session-settings__retry")!.click();
  await settle(sheet);
  expect(request.mock.calls.filter(([method]) => method === "tools.effective")).toHaveLength(2);
  expect(text(permissions.querySelector(".session-settings__headline"))).toContain("Delegated");
});

it("keeps the latest read when an earlier attempt of the same section fails late", async () => {
  let failSlow: (error: Error) => void = () => {};
  let attempts = 0;
  const { sheet } = await mountSheet({
    session: { capabilityStatus: promotionProjection("authorized-none") },
    respond: (method) => {
      if (method !== "tools.effective") {
        return undefined;
      }
      attempts += 1;
      if (attempts === 1) {
        return new Error("boom");
      }
      return attempts === 2
        ? new Promise((_resolve, reject) => {
            failSlow = reject;
          })
        : delegatedTools;
    },
  });
  const permissions = section(sheet, "permissions");
  // Two Retry taps before the sheet re-renders start two reads of the same section.
  const retry = permissions.querySelector<HTMLButtonElement>(".session-settings__retry")!;
  retry.click();
  retry.click();
  await settle(sheet);
  expect(text(permissions.querySelector(".session-settings__headline"))).toContain("Delegated");
  failSlow(new Error("slow"));
  await settle(sheet);
  expect(text(permissions.querySelector(".session-settings__headline"))).toContain("Delegated");
  expect(permissions.querySelector('[role="alert"]')).toBeNull();
});

it("opens at the requested section with its summary as the initial focus target", async () => {
  const { sheet } = await mountSheet({ initialSection: "usage", row: { inputTokens: 1200 } });
  const usage = section(sheet, "usage");
  expect(usage.open).toBe(true);
  expect(usage.querySelector("summary")!.hasAttribute("autofocus")).toBe(true);
  expect(sheet.content!.querySelector(".session-settings__close")!.hasAttribute("autofocus")).toBe(
    false,
  );
  expect(
    [...usage.querySelectorAll("dt")].map((term) => [text(term), text(term.nextElementSibling)]),
  ).toContainEqual(["Input", "1.2k"]);
});

it("runs built-in actions through the host and closes first for dialogs", async () => {
  const { sheet, onAction, onClose } = await mountSheet({
    session: { capabilityStatus: promotionProjection("authorized-none") },
  });
  const actions = section(sheet, "actions");
  expect(
    [...actions.querySelectorAll("[data-action]")].map((item) => item.getAttribute("data-action")),
  ).toEqual(["promotion", "rename", "owner", "group", "pin", "archive"]);
  actions.querySelector<HTMLButtonElement>('[data-action="pin"] button')!.click();
  expect(onAction).toHaveBeenLastCalledWith({ kind: "toggle-pin" });
  expect(onClose).not.toHaveBeenCalled();
  actions.querySelector<HTMLButtonElement>('[data-action="promotion"] button')!.click();
  expect(onClose).toHaveBeenCalledOnce();
  expect(onAction).toHaveBeenLastCalledWith({ kind: "promote-session" });

  const group = actions.querySelector<HTMLSelectElement>('[data-action="group"] select')!;
  group.selectedIndex = group.options.length - 1;
  group.dispatchEvent(new Event("change"));
  expect(onAction).toHaveBeenLastCalledWith({ kind: "new-group" });
});

it("lists a registered action without any change to the sheet", async () => {
  const run = vi.fn();
  const unregister = registerSessionSettingsAction({
    id: "grant-capability",
    order: 15,
    resolve: (target) =>
      target.session.capabilityStatus?.effectiveClass === "delegated"
        ? { label: "Grant one capability…", run }
        : null,
  });
  try {
    const { sheet } = await mountSheet({
      session: { capabilityStatus: promotionProjection("authorized-none") },
    });
    const ids = [...section(sheet, "actions").querySelectorAll("[data-action]")].map((item) =>
      item.getAttribute("data-action"),
    );
    expect(ids.slice(0, 2)).toEqual(["promotion", "grant-capability"]);
    sheet
      .content!.querySelector<HTMLButtonElement>('[data-action="grant-capability"] button')!
      .click();
    expect(run).toHaveBeenCalledOnce();
  } finally {
    unregister();
  }
});

it("refuses a registration that would replace a built-in action such as Promote", () => {
  expect(() =>
    registerSessionSettingsAction({
      id: "promotion",
      order: 10,
      resolve: () => ({ label: "Promote", run: () => {} }),
    }),
  ).toThrow(/reserved/);
});

it("closes on the dialog's cancel (Escape or a tap outside)", async () => {
  const { sheet, onClose } = await mountSheet({});
  sheet
    .content!.querySelector("openclaw-modal-dialog")!
    .dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true, composed: true }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("renders outside its host, so pane key and tap handlers never reach it, and cleans up", async () => {
  const { sheet } = await mountSheet({});
  const content = sheet.content!;
  // A pane closes every open <details> under it on Escape or an outside tap.
  expect(sheet.contains(content)).toBe(false);
  expect(content.parentElement).toBe(document.body);
  sheet.open = false;
  await sheet.updateComplete;
  expect(sheet.content).toBeNull();
  expect(content.isConnected).toBe(false);
  sheet.open = true;
  await sheet.updateComplete;
  const reopened = sheet.content!;
  sheet.remove();
  expect(reopened.isConnected).toBe(false);
});
