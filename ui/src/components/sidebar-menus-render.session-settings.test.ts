/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SessionMenuAction } from "./session-menu.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";
import {
  renderSidebarSessionMenuForController,
  renderSidebarSessionSettingsForController,
} from "./sidebar-menus-render.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
});

function harness() {
  const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
  const context = createContext(createGateway(client), createSessions("main", []));
  const session = {
    key: "agent:main:dashboard:one",
    sessionId: "s-1",
    label: "One",
    renameValue: "One",
    active: false,
    visuallyActive: false,
    hasActiveRun: false,
    modelSelectionLocked: false,
    pinned: false,
    pinnable: true,
    unread: false,
    hasAutomation: false,
    cloudWorkerStopAction: null,
  } as SidebarRecentSession;
  const sessionOrganizer = { patchSession: vi.fn(), renameSession: vi.fn() };
  const host = {
    connected: true,
    sessionDataContext: context,
    sessionData: { sessionsResult: null, sessionsLoading: false },
    sessionsGrouping: "none",
    sessionOrganizer,
    findSidebarMenuSessionByKey: () => session,
    selectedVisibleSessions: () => [],
    readSessionMutationAccess: () => ({ allowed: true }),
    knownSessionGroups: () => ["Projects"],
    getSessionNavigationState: () => ({ selectedAgentId: "main" }),
    requestUpdate: vi.fn(),
  };
  const trigger = document.createElement("button");
  const controller = {
    host,
    sessionMenu: { session, x: 0, y: 0 } as SidebarMenusController["sessionMenu"],
    sessionMenuTrigger: trigger,
    sessionMenuWork: null,
    sessionSettings: null as SidebarMenusController["sessionSettings"],
    pluginActionLifetime: new AbortController(),
    openSessionSettings: vi.fn((opened: SidebarRecentSession, returnFocus: HTMLElement | null) => {
      controller.sessionSettings = { session: opened, returnFocus };
    }),
    closeSessionSettings: vi.fn(() => {
      controller.sessionSettings = null;
    }),
    closeSessionMenu: vi.fn(),
  };
  const container = createApplicationContextProvider(context);
  containers.push(container);
  document.body.append(container);
  return {
    controller: controller as unknown as SidebarMenusController & typeof controller,
    session,
    sessionOrganizer,
    trigger,
    container,
  };
}

it("opens the sheet from the sidebar menu and runs its actions through the sidebar handlers", async () => {
  const { controller, session, sessionOrganizer, trigger, container } = harness();
  render(renderSidebarSessionMenuForController(controller), container);
  const menu = container.querySelector<
    HTMLElement & {
      settingsAvailable: boolean;
      onAction: (action: SessionMenuAction) => void;
      updateComplete: Promise<unknown>;
    }
  >("openclaw-session-menu")!;
  await menu.updateComplete;
  expect(menu.settingsAvailable).toBe(true);
  menu.onAction({ kind: "session-settings" });
  expect(controller.openSessionSettings).toHaveBeenCalledWith(session, trigger);

  render(renderSidebarSessionSettingsForController(controller), container);
  const sheet = container.querySelector("openclaw-session-settings-sheet")!;
  await sheet.updateComplete;
  expect(sheet.open).toBe(true);
  expect(sheet.returnFocus).toBe(trigger);
  expect(sheet.promotionCheck).toBe(false);
  expect(sheet.session).toMatchObject({ key: session.key, sessionId: "s-1", label: "One" });

  sheet.onAction({ kind: "toggle-pin" });
  expect(sessionOrganizer.patchSession).toHaveBeenCalledWith(
    expect.objectContaining({ key: session.key }),
    { pinned: true },
    { sessionScope: true },
  );
  // The sidebar has no status check; the sheet's request for one is ignored, not misrouted.
  sheet.onAction({ kind: "check-promotion" });
  sheet.onClose();
  expect(controller.closeSessionSettings).toHaveBeenCalledOnce();
  render(renderSidebarSessionSettingsForController(controller), container);
  expect(container.querySelector("openclaw-session-settings-sheet")).toBeNull();
});
