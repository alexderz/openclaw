import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  PENDING_REQUEST_ID,
  promotionProjection,
  type PromotionFixtureKind,
} from "../lib/sessions/session-promotion.test-support.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const key = "agent:main:dashboard:promotion-proof";
const menuName = { name: "Actions for Handoff candidate" };

// "narrow-320-hidpi" is a 320 CSS-pixel viewport at deviceScaleFactor 2. It proves narrow layout
// and raster density only. It is NOT a real 200% browser or text-layout zoom.
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900, scale: 1, touch: false },
  { name: "mobile-320", width: 320, height: 844, scale: 1, touch: true },
  { name: "narrow-320-hidpi", width: 320, height: 500, scale: 2, touch: false },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

async function openHandoffPage(viewport: Viewport, kind: PromotionFixtureKind) {
  const context = await suite.browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.scale,
    hasTouch: viewport.touch,
    locale: "en-US",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    operatorScopes: ["operator.read", "operator.write", "operator.admin"],
    featureMethods: ["chat.metadata", "chat.startup", "sessions.promote"],
    methodResponses: {
      "sessions.list": sessionsListResponse([
        {
          ...sessionRow(key, "Handoff candidate", Date.now()),
          promotion: { ...promotionProjection(kind), lifecycleRevision: "proof-revision" },
        },
      ]),
      "sessions.promote": {
        key,
        sessionId: "proof-session",
        lifecycleRevision: "proof-revision",
        requestId: PENDING_REQUEST_ID,
        state: "cancelled",
        activation: "safe-boundary-before-fresh-human-run",
        effective: { class: "delegated" },
      },
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
  return { context, page, gateway, host: page.locator("openclaw-chat-header-session-menu") };
}

async function openPromotionMenuItem(page: Page, value: string) {
  await page.getByRole("button", menuName).click();
  const item = page.locator(`openclaw-chat-header-session-menu wa-dropdown-item[value="${value}"]`);
  await item.waitFor({ state: "visible" });
  await expect
    .poll(() => item.evaluate((element) => Math.round(element.getBoundingClientRect().height)))
    .toBeGreaterThanOrEqual(44);
  return item;
}

/**
 * Measured 44 CSS px target size for each button of the open confirmation dialog. The shared
 * dialog applies it at <=768px; desktop keeps the stock button size, so it is not asserted there.
 */
async function expectDialogButtonsAtLeast44(page: Page) {
  if ((page.viewportSize()?.width ?? 0) > 768) {
    return;
  }
  const buttons = page.locator(".exec-approval-actions button");
  expect(await buttons.count()).toBe(2);
  for (const size of await buttons.evaluateAll((elements) =>
    elements.map((element) => {
      // Layout size, so the dialog's opening scale animation cannot skew the measurement.
      const button = element as HTMLElement;
      return {
        name: button.textContent?.trim(),
        width: button.offsetWidth,
        height: button.offsetHeight,
      };
    }),
  )) {
    expect(size.height, size.name + " height").toBeGreaterThanOrEqual(44);
    expect(size.width, size.name + " width").toBeGreaterThanOrEqual(44);
  }
}

suite.define(() => {
  it.each(VIEWPORTS)(
    "renders an accessible handoff at $name without live Gateway access",
    async (viewport) => {
      const { context, page, host } = await openHandoffPage(viewport, "authorized-none");
      try {
        await expect
          .poll(() => host.locator('[role="status"]').textContent())
          .toContain("Delegated · limited");
        await host.locator("summary").focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => host.locator("details").getAttribute("open")).not.toBeNull();
        const detailBounds = await host.locator("details").boundingBox();
        expect(detailBounds!.x + detailBounds!.width).toBeLessThanOrEqual(viewport.width);
        await captureUiProof(suite, page, "session-promotion-" + viewport.name + "-details.png");
        const promote = await openPromotionMenuItem(page, "promote-session");
        await captureUiProof(suite, page, "session-promotion-" + viewport.name + "-menu.png");
        await promote.click();
        await page
          .getByRole("button", { name: "Cancel", exact: true })
          .waitFor({ state: "visible" });
        await expect
          .poll(() =>
            page
              .getByRole("button", { name: "Cancel", exact: true })
              .evaluate((element) => element.matches(":focus-within")),
          )
          .toBe(true);
        await expectDialogButtonsAtLeast44(page);
        await captureUiProof(suite, page, "session-promotion-" + viewport.name + "-confirm.png");
        await page.keyboard.press("Escape");
        await expect
          .poll(() =>
            page
              .getByRole("button", menuName)
              .evaluate((element) => element.matches(":focus-within")),
          )
          .toBe(true);
      } catch (error) {
        await captureUiProof(suite, page, "session-promotion-" + viewport.name + "-failure.png");
        throw error;
      } finally {
        await context.close();
      }
    },
    90_000,
  );

  it("cancels an authorized pending handoff with the projected original request id", async () => {
    const { context, page, gateway, host } = await openHandoffPage(
      VIEWPORTS[1],
      "authorized-pending",
    );
    try {
      await expect
        .poll(() => host.locator('[role="status"]').textContent())
        .toContain("Promotion pending");
      const cancel = await openPromotionMenuItem(page, "cancel-promotion");
      expect(await cancel.getAttribute("disabled")).toBeNull();
      await cancel.click();
      await page
        .getByRole("button", { name: "Cancel promotion", exact: true })
        .waitFor({ state: "visible" });
      await expectDialogButtonsAtLeast44(page);
      await captureUiProof(suite, page, "session-promotion-pending-cancel-confirm.png");
      await page.getByRole("button", { name: "Cancel promotion", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("sessions.promote")).length).toBe(1);
      const [request] = await gateway.getRequests("sessions.promote");
      expect(requireRecord(request!.params)).toEqual({
        key,
        expectedSessionId: expect.any(String),
        expectedLifecycleRevision: "proof-revision",
        requestId: PENDING_REQUEST_ID,
        action: "cancel",
      });
    } catch (error) {
      await captureUiProof(suite, page, "session-promotion-pending-cancel-failure.png");
      throw error;
    } finally {
      await context.close();
    }
  }, 90_000);

  it.each(["unauthorized-pending", "restricted-viewer"] as const)(
    "offers no cancel or request for %s",
    async (kind) => {
      const { context, page, gateway } = await openHandoffPage(VIEWPORTS[1], kind);
      try {
        await page.getByRole("button", menuName).click();
        const item = page
          .locator("openclaw-chat-header-session-menu wa-dropdown-item.session-promotion-action")
          .first();
        await item.waitFor({ state: "visible" });
        expect(await item.getAttribute("disabled")).not.toBeNull();
        await item.click({ force: true });
        expect(await page.locator(".exec-approval-actions").count()).toBe(0);
        expect(await gateway.getRequests("sessions.promote")).toHaveLength(0);
      } catch (error) {
        await captureUiProof(suite, page, "session-promotion-" + kind + "-failure.png");
        throw error;
      } finally {
        await context.close();
      }
    },
    90_000,
  );
});
