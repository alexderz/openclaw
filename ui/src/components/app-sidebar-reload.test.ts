/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { reloadControlUiManually } from "../app/manual-reload.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGatewayHarness, createSessions, mountSidebar } from "../test-helpers/app-sidebar.ts";
import "./app-sidebar.ts";

vi.mock("../app/manual-reload.ts", () => ({
  reloadControlUiManually: vi.fn(async () => true),
}));

setupSidebarTest();

describe("AppSidebar reload item", () => {
  it("offers Reload in the app menu and reloads through the worker-aware path", async () => {
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card")!.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu")!;
    const item = menu.querySelector<HTMLElement>('wa-dropdown-item[value="command:reload"]')!;
    expect(item.querySelector(".sidebar-customize-menu__text")?.textContent?.trim()).toBe("Reload");
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item }, bubbles: true }));
    await sidebar.updateComplete;
    await vi.waitFor(() => expect(reloadControlUiManually).toHaveBeenCalledOnce());
    expect(sidebar.querySelector(".sidebar-identity-menu")).toBeNull();
  });
});
