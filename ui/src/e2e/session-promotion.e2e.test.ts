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

const ada = {
  type: "human",
  id: "profile-ada",
  identity: { type: "profile", id: "profile-ada" },
  label: "Ada",
} as const;

/** Header neighbours from Alex's phone report: workspace label, avatars and the menu triggers. */
const crowdedHeaderRow = {
  spawnedCwd: "/repo/openclaw",
  createdActor: ada,
  owner: { actor: ada },
  participants: [{ identity: { type: "profile", id: "profile-zoe" }, label: "Zoe" }],
  participantCount: 1,
};

async function openHandoffPage(
  viewport: Viewport,
  kind: PromotionFixtureKind,
  promoteResponse: unknown = {
    key,
    sessionId: "proof-session",
    lifecycleRevision: "proof-revision",
    requestId: PENDING_REQUEST_ID,
    state: "cancelled",
    activation: "safe-boundary-before-fresh-human-run",
    effective: { class: "delegated" },
  },
  crowdedHeader = false,
) {
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
    hasMultipleSessionSharingIdentities: crowdedHeader,
    operatorScopes: ["operator.read", "operator.write", "operator.admin"],
    featureMethods: ["chat.metadata", "chat.startup", "sessions.promote"],
    methodResponses: {
      "sessions.list": sessionsListResponse([
        {
          ...sessionRow(key, "Handoff candidate", Date.now()),
          ...(crowdedHeader ? crowdedHeaderRow : {}),
          promotion: { ...promotionProjection(kind), lifecycleRevision: "proof-revision" },
        },
      ]),
      "sessions.promote": promoteResponse,
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
        const detailsToggle = host.getByRole("button", { name: "Session capability details" });
        await detailsToggle.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => detailsToggle.getAttribute("aria-expanded")).toBe("true");
        const detailBounds = await host.locator(".session-capability-details").boundingBox();
        expect(detailBounds!.x).toBeGreaterThanOrEqual(0);
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

  it.each([VIEWPORTS[0], VIEWPORTS[1]])(
    "keeps the capability glyph and details button inline beside the $name header controls",
    async (viewport) => {
      const { context, page, host } = await openHandoffPage(
        viewport,
        "authorized-none",
        undefined,
        true,
      );
      const header = page.locator(".chat-pane__header").first();
      try {
        const badge = host.locator(".session-capability-status");
        await expect.poll(() => badge.getAttribute("aria-label")).toBe("Delegated · limited");
        await expect
          .poll(() => header.locator(".chat-pane__participants .viewer-avatar").count())
          .toBeGreaterThan(0);
        const toggle = host.getByRole("button", { name: "Session capability details" });
        const neighbours = {
          workspace: header.locator(".chat-pane__workspace-chip"),
          owner: header.locator(".session-owner-chip--header"),
          avatars: header.locator(".chat-pane__participants .viewer-avatar"),
          title: header.locator(".chat-pane__session-title"),
          menu: page.getByRole("button", menuName),
          hamburger: page.locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible"),
        };
        const box = async (locator: typeof badge, name = "header") => {
          await locator.first().waitFor({ state: "visible" });
          const bounds = await locator.first().boundingBox();
          expect(bounds, name + " bounds").not.toBeNull();
          return bounds!;
        };
        const headerBefore = await box(header);
        const own = { badge: await box(badge, "badge"), toggle: await box(toggle, "toggle") };
        expect(own.toggle.width).toBeGreaterThanOrEqual(44);
        expect(own.toggle.height).toBeGreaterThanOrEqual(44);
        const intersects = (
          a: { x: number; y: number; width: number; height: number },
          b: typeof a,
        ) =>
          a.x < b.x + b.width - 0.5 &&
          b.x < a.x + a.width - 0.5 &&
          a.y < b.y + b.height - 0.5 &&
          b.y < a.y + a.height - 0.5;
        const placed: Record<string, Awaited<ReturnType<typeof box>>> = {};
        for (const [name, locator] of Object.entries(neighbours)) {
          const elements = await locator.all();
          for (const [index, element] of elements.entries()) {
            if (await element.isVisible()) {
              placed[elements.length > 1 ? name + index : name] = await box(element, name);
            }
          }
        }
        expect(Object.keys(placed)).toEqual(
          expect.arrayContaining(["workspace", "owner", "avatars", "title", "menu"]),
        );
        if (viewport.touch) {
          expect(Object.keys(placed)).toContain("hamburger");
        }
        for (const [ownName, ownBox] of Object.entries(own)) {
          // Same header row: no wrapped second line under the title.
          expect(ownBox.y, ownName + " top").toBeGreaterThanOrEqual(headerBefore.y - 0.5);
          expect(ownBox.y + ownBox.height, ownName + " bottom").toBeLessThanOrEqual(
            headerBefore.y + headerBefore.height + 0.5,
          );
          expect(ownBox.x + ownBox.width, ownName + " right").toBeLessThanOrEqual(viewport.width);
          for (const [name, bounds] of Object.entries(placed)) {
            expect(intersects(ownBox, bounds), ownName + " overlaps " + name).toBe(false);
          }
        }
        expect(intersects(own.badge, own.toggle), "badge overlaps details button").toBe(false);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          "no horizontal page overflow",
        ).toBeLessThanOrEqual(viewport.width);
        await captureUiProof(suite, page, "session-capability-" + viewport.name + "-header.png");

        await toggle.click();
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
        // The panel overlays the conversation; opening it must not push the header around.
        expect(await box(header)).toEqual(headerBefore);
        expect(await box(badge)).toEqual(own.badge);
        // Visible on top of the conversation, not clipped by or painted under a pane ancestor.
        const panel = host.locator(".session-capability-details");
        const panelBox = await box(panel, "details panel");
        expect(panelBox.x).toBeGreaterThanOrEqual(0);
        expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
        expect(
          await panel.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + Math.min(rect.height / 2, 40),
            );
            return hit ? element.contains(hit) : false;
          }),
          "details panel is the topmost element at its center",
        ).toBe(true);
        await captureUiProof(suite, page, "session-capability-" + viewport.name + "-details.png");
      } catch (error) {
        await captureUiProof(suite, page, "session-capability-" + viewport.name + "-failure.png");
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

  it("shows a definite refusal, not an unknown result, when the Gateway denies the request", async () => {
    const { context, page, gateway, host } = await openHandoffPage(
      VIEWPORTS[1],
      "authorized-none",
      { __mockError: { code: "FORBIDDEN", message: "Session promotion is not available." } },
    );
    try {
      const promote = await openPromotionMenuItem(page, "promote-session");
      await promote.click();
      await page
        .getByRole("button", { name: "Promote session", exact: true })
        .waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Promote session", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("sessions.promote")).length).toBe(1);
      await expect
        .poll(() => host.locator('[role="status"]').textContent())
        .toContain("Promotion isn't allowed for this session");
      expect(await host.locator('[role="status"]').textContent()).not.toContain("unknown");
      await captureUiProof(suite, page, "session-promotion-denied.png");
    } catch (error) {
      await captureUiProof(suite, page, "session-promotion-denied-failure.png");
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
