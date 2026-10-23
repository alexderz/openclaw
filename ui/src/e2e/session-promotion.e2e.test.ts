import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
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
  waitForMobileSidebarDrawerOpen,
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
  look: {
    colorScheme?: "light" | "dark";
    promotion?: ReturnType<typeof promotionProjection>;
    /** Extra wire fields for the one row, such as a registry spawnedBy overlay. */
    row?: Partial<GatewaySessionRow>;
    methods?: string[];
  } = {},
) {
  const context = await suite.browser.newContext({
    colorScheme: look.colorScheme ?? "light",
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
    featureMethods: ["chat.metadata", "chat.startup", "sessions.promote", ...(look.methods ?? [])],
    methodResponses: {
      "sessions.list": sessionsListResponse([
        {
          ...sessionRow(key, "Handoff candidate", Date.now()),
          ...(crowdedHeader ? crowdedHeaderRow : {}),
          ...look.row,
          promotion: {
            ...(look.promotion ?? promotionProjection(kind)),
            lifecycleRevision: "proof-revision",
          },
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
        // The capability glyph is the info button; its name is the capability in words.
        const detailsToggle = host.getByRole("button", { name: "Delegated · limited" });
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
        const toggle = host.getByRole("button", { name: "Delegated · limited" });
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
        const own = { toggle: await box(toggle, "toggle") };
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
        expect(await box(badge), "the badge is the info button").toEqual(own.toggle);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          "no horizontal page overflow",
        ).toBeLessThanOrEqual(viewport.width);
        await captureUiProof(suite, page, "session-capability-" + viewport.name + "-header.png");

        await toggle.click();
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
        // The panel overlays the conversation; opening it must not push the header around.
        expect(await box(header)).toEqual(headerBefore);
        expect(await box(badge)).toEqual(own.toggle);
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

  it("promotes from the sidebar row menu through the same confirm and request as the header", async () => {
    const { context, page, gateway } = await openHandoffPage(VIEWPORTS[0], "authorized-none");
    try {
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await expect.poll(() => row.count()).toBe(1);
      await row.click({ button: "right" });
      const menu = page.locator("openclaw-session-menu");
      const promote = menu.locator('wa-dropdown-item[value="promote-session"]');
      await promote.waitFor({ state: "visible" });
      expect(await promote.getAttribute("disabled")).toBeNull();
      // The status check stays in the chat header; the row menu only offers the request.
      expect(await menu.locator('wa-dropdown-item[value="check-promotion"]').count()).toBe(0);
      await captureUiProof(suite, page, "session-promotion-sidebar-menu.png");
      await promote.click();
      const confirm = page.getByRole("button", { name: "Promote session", exact: true });
      await confirm.waitFor({ state: "visible" });
      await captureUiProof(suite, page, "session-promotion-sidebar-confirm.png");
      await confirm.click();
      await expect.poll(async () => (await gateway.getRequests("sessions.promote")).length).toBe(1);
      const [request] = await gateway.getRequests("sessions.promote");
      expect(requireRecord(request!.params)).toEqual({
        key,
        expectedSessionId: expect.any(String),
        expectedLifecycleRevision: "proof-revision",
        requestId: expect.any(String),
        action: "request",
      });
    } catch (error) {
      await captureUiProof(suite, page, "session-promotion-sidebar-failure.png");
      throw error;
    } finally {
      await context.close();
    }
  }, 90_000);

  it("disables the sidebar Promote with the reason when this viewer may not promote", async () => {
    const { context, page, gateway } = await openHandoffPage(VIEWPORTS[0], "restricted-viewer");
    try {
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await expect.poll(() => row.count()).toBe(1);
      await row.click({ button: "right" });
      const menu = page.locator("openclaw-session-menu");
      const promote = menu.locator('wa-dropdown-item[value="promote-session"]');
      await promote.waitFor({ state: "visible" });
      expect(await promote.getAttribute("disabled")).not.toBeNull();
      expect(await promote.getAttribute("title")).toContain("current-human-authorization-required");
      await promote.click({ force: true });
      expect(await page.locator(".exec-approval-actions").count()).toBe(0);
      expect(await gateway.getRequests("sessions.promote")).toHaveLength(0);
    } finally {
      await context.close();
    }
  }, 90_000);

  it("shows nothing promotion-related for a standard session in the header or sidebar", async () => {
    const { context, page } = await openHandoffPage(
      VIEWPORTS[0],
      "authorized-none",
      undefined,
      false,
      {
        promotion: {
          ...promotionProjection("authorized-none"),
          historicalOrigin: "ordinary",
          effectiveClass: "ordinary",
          classScope: "all-turns",
          canPromote: false,
          disabledReasons: ["unsupported-target:not-delegated"],
        },
      },
    );
    try {
      await page.getByRole("button", menuName).click();
      const header = page.locator("openclaw-chat-header-session-menu");
      await header.locator('wa-dropdown-item[value="rename"]').waitFor({ state: "visible" });
      expect(await header.locator(".session-promotion-action").count()).toBe(0);
      expect(await header.textContent()).not.toContain("Check promotion status");
      await page.keyboard.press("Escape");
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await row.click({ button: "right" });
      const menu = page.locator("openclaw-session-menu");
      await menu.locator('wa-dropdown-item[value="rename"]').waitFor({ state: "visible" });
      expect(await menu.locator(".session-promotion-action").count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 90_000);

  it("offers Pin when the Gateway reports a registry-linked dashboard row pinnable", async () => {
    const { context, page } = await openHandoffPage(
      VIEWPORTS[0],
      "authorized-none",
      undefined,
      false,
      {
        // spawnedBy comes from the subagent-run registry; the stored entry is still a root.
        row: { spawnedBy: "agent:main:main", pinnable: true },
        methods: ["sessions.patch"],
      },
    );
    try {
      await page.getByRole("button", menuName).click();
      const pin = page.locator(
        'openclaw-chat-header-session-menu wa-dropdown-item[value="toggle-pin"]',
      );
      await pin.waitFor({ state: "visible" });
      expect(await pin.getAttribute("title")).not.toBe(
        "Only root sessions can be pinned; pin the parent session instead.",
      );
      expect(await pin.getAttribute("disabled")).toBeNull();
      await captureUiProof(suite, page, "session-promotion-pinnable-header.png");
    } finally {
      await context.close();
    }
  }, 90_000);

  /** A natively ordinary row, as projectSessionPromotion returns it for a never-delegated key. */
  const standardRow = {
    ...promotionProjection("authorized-none"),
    historicalOrigin: "ordinary",
    effectiveClass: "ordinary",
    classScope: "all-turns",
    canPromote: false,
    disabledReasons: ["unsupported-target:not-delegated"],
  } satisfies ReturnType<typeof promotionProjection>;
  const BUBBLE_STATES = [
    {
      name: "standard",
      kind: "authorized-none",
      promotion: standardRow,
      glyph: "Ordinary · policy-limited",
    },
    { name: "delegated", kind: "authorized-none", glyph: "Delegated · limited" },
    { name: "pending", kind: "authorized-pending", glyph: "Promotion pending" },
    {
      name: "promoted",
      kind: "promoted-detached",
      promotion: promotionProjection("promoted-detached"),
      glyph: "Ordinary · policy-limited",
    },
  ] as const;

  it.each(
    [VIEWPORTS[0], VIEWPORTS[1]].flatMap((viewport) =>
      (["light", "dark"] as const).flatMap((colorScheme) =>
        BUBBLE_STATES.map((state) => ({
          viewport,
          colorScheme,
          state,
          label: `${state.name} ${viewport.name} ${colorScheme}`,
        })),
      ),
    ),
  )(
    "opens the info bubble from the capability glyph: $label",
    async ({ viewport, colorScheme, state }) => {
      const { context, page, host } = await openHandoffPage(
        viewport,
        state.kind,
        undefined,
        false,
        { colorScheme, ...("promotion" in state ? { promotion: state.promotion } : {}) },
      );
      const name = `session-info-${state.name}-${viewport.name}-${colorScheme}`;
      try {
        const toggle = host.getByRole("button", { name: state.glyph, exact: true });
        await toggle.click();
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
        const panel = host.locator(".session-capability-details");
        await panel.waitFor({ state: "visible" });
        const panelBox = (await panel.boundingBox())!;
        expect(panelBox.x).toBeGreaterThanOrEqual(0);
        expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
        const actions = panel.locator("[data-promotion-action]");
        expect(
          await actions.evaluateAll((buttons) =>
            buttons.map((button) => (button as HTMLElement).dataset.promotionAction),
          ),
        ).toEqual(
          state.name === "standard" || state.name === "promoted"
            ? []
            : state.name === "pending"
              ? ["cancel-promotion"]
              : ["promote-session"],
        );
        for (const box of await actions.evaluateAll((buttons) =>
          buttons.map((button) => (button as HTMLElement).offsetHeight),
        )) {
          expect(box).toBeGreaterThanOrEqual(44);
        }
        if (state.name === "promoted") {
          // A standard session with its history: no promotion controls, no limited wording.
          const text = (await panel.textContent()) ?? "";
          // The parent row is not listed here, so it is named by its key.
          expect(text).toContain("Promoted from agent:main:dashboard:parent on");
          expect(text).not.toContain("Started as delegated");
        }
        await captureUiProof(suite, page, name + ".png");
        if (state.name === "delegated") {
          await panel.locator('[data-promotion-action="promote-session"]').click();
          await page
            .getByRole("button", { name: "Promote session", exact: true })
            .waitFor({ state: "visible" });
          await expectDialogButtonsAtLeast44(page);
          expect(await panel.isHidden()).toBe(true);
        }
      } catch (error) {
        await captureUiProof(suite, page, name + "-failure.png");
        throw error;
      } finally {
        await context.close();
      }
    },
    90_000,
  );

  /** One limited, one pending and one ordinary row, as the Gateway projects them for this viewer. */
  const TICK_ROWS = [
    {
      key: "agent:main:dashboard:tick-limited",
      label: "Limited worker",
      promotion: promotionProjection("authorized-none"),
      mark: "limited",
      description: "Limited session",
    },
    {
      key: "agent:main:dashboard:tick-pending",
      label: "Pending handoff",
      promotion: promotionProjection("authorized-pending"),
      mark: "pending",
      description: "Promotion pending",
    },
    {
      key: "agent:main:dashboard:tick-ordinary",
      label: "Ordinary chat",
      promotion: standardRow,
      mark: undefined,
      description: undefined,
    },
    {
      key: "agent:main:dashboard:tick-promoted",
      label: "Promoted chat",
      promotion: promotionProjection("promoted-detached"),
      mark: undefined,
      description: undefined,
    },
  ] as const;
  const TICK_VIEWPORTS = [
    { name: "desktop", width: 1280, height: 900, scale: 1, touch: false },
    { name: "phone390", width: 390, height: 844, scale: 2, touch: true },
  ] as const;

  it.each(
    TICK_VIEWPORTS.flatMap((viewport) =>
      (["light", "dark"] as const).map((colorScheme) => ({
        viewport,
        colorScheme,
        label: `${viewport.name} ${colorScheme}`,
      })),
    ),
  )(
    "marks only limited and pending sidebar rows with an amber tick: $label",
    async ({ viewport, colorScheme }) => {
      const context = await suite.browser.newContext({
        colorScheme,
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.scale,
        hasTouch: viewport.touch,
        locale: "en-US",
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const now = Date.now();
      await installMockGateway(page, {
        sessionKey: TICK_ROWS[2].key,
        operatorScopes: ["operator.read", "operator.write", "operator.admin"],
        featureMethods: ["chat.metadata", "chat.startup", "sessions.promote"],
        methodResponses: {
          "sessions.list": sessionsListResponse(
            TICK_ROWS.map((row, index) => ({
              ...sessionRow(row.key, row.label, now - index * 1000),
              promotion: { ...row.promotion, lifecycleRevision: "proof-revision" },
            })),
          ),
        },
      });
      const name = `sidebar-tick-${viewport.name}-${colorScheme}`;
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, TICK_ROWS[2].key));
        if (viewport.touch) {
          await page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first()
            .click();
          await waitForMobileSidebarDrawerOpen(page);
        }
        const rowFor = (rowKey: string) =>
          page.locator(`.sidebar-recent-session[data-session-key="${rowKey}"]`);
        for (const row of TICK_ROWS) {
          await rowFor(row.key).locator(".sidebar-recent-session__name").waitFor();
        }
        const nameLeft: number[] = [];
        for (const row of TICK_ROWS) {
          const host = rowFor(row.key);
          const ticks = host.locator(".sidebar-session-promotion-tick");
          const link = host.locator(".sidebar-recent-session__link");
          const described = await link.evaluate((element) =>
            (element.getAttribute("aria-describedby") ?? "")
              .split(" ")
              .filter(Boolean)
              .map((id) => document.getElementById(id)?.textContent?.trim()),
          );
          const nameBox = (await host.locator(".sidebar-recent-session__name").boundingBox())!;
          nameLeft.push(nameBox.x);
          if (!row.mark) {
            expect(await ticks.count(), row.label).toBe(0);
            expect(described, row.label).not.toContain("Limited session");
            expect(described, row.label).not.toContain("Promotion pending");
            continue;
          }
          expect(await ticks.count(), row.label).toBe(1);
          const tick = ticks.first();
          expect(await tick.getAttribute("class")).toContain(
            "sidebar-session-promotion-tick--" + row.mark,
          );
          // Not color-only: the words are the link's description and the tick's tooltip.
          expect(await tick.getAttribute("title")).toBe(row.description);
          expect(await tick.getAttribute("aria-hidden")).toBe("true");
          expect(described, row.label).toContain(row.description);
          const tickBox = (await tick.boundingBox())!;
          expect(Math.round(tickBox.width)).toBe(3);
          expect(tickBox.height).toBeGreaterThanOrEqual(12);
          // In the gutter before the title, vertically on the title line, never under the text.
          expect(tickBox.x + tickBox.width).toBeLessThanOrEqual(nameBox.x + 0.5);
          expect(tickBox.x).toBeGreaterThanOrEqual(0);
          expect(tickBox.y).toBeGreaterThanOrEqual(nameBox.y - 4);
          expect(tickBox.y + tickBox.height).toBeLessThanOrEqual(nameBox.y + nameBox.height + 4);
          const style = await tick.evaluate((element) => {
            const computed = getComputedStyle(element);
            return {
              color: computed.backgroundColor,
              image: computed.backgroundImage,
              warn: getComputedStyle(document.documentElement).getPropertyValue("--warn").trim(),
            };
          });
          if (row.mark === "pending") {
            expect(style.image).toContain("repeating-linear-gradient");
          } else {
            expect(style.image).toBe("none");
            // WCAG 1.4.11 non-text contrast against the first opaque sidebar background.
            const contrast = await tick.evaluate((element) => {
              const canvas = document.createElement("canvas");
              canvas.width = 1;
              canvas.height = 1;
              const context2d = canvas.getContext("2d", { willReadFrequently: true })!;
              const rgb = (color: string) => {
                context2d.clearRect(0, 0, 1, 1);
                context2d.fillStyle = color;
                context2d.fillRect(0, 0, 1, 1);
                return [...context2d.getImageData(0, 0, 1, 1).data];
              };
              let background = [0, 0, 0, 0];
              for (let node = element.parentElement; node; node = node.parentElement) {
                background = rgb(getComputedStyle(node).backgroundColor);
                if (background[3] === 255) {
                  break;
                }
              }
              const luminance = (rgbValues: number[]) =>
                rgbValues
                  .slice(0, 3)
                  .map((channel) => channel / 255)
                  .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
                  .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index]!, 0);
              const [a, b] = [
                luminance(rgb(getComputedStyle(element).backgroundColor)),
                luminance(background),
              ];
              return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            });
            expect(contrast, row.label + " tick contrast").toBeGreaterThanOrEqual(3);
          }
          expect(style.warn).not.toBe("");
        }
        // Costs no title width: every title starts at the same x, marked or not.
        expect(Math.max(...nameLeft) - Math.min(...nameLeft)).toBeLessThan(0.5);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          "no horizontal page overflow",
        ).toBeLessThanOrEqual(viewport.width);
        await captureUiProof(suite, page, name + ".png");
      } catch (error) {
        await captureUiProof(suite, page, name + "-failure.png");
        throw error;
      } finally {
        await context.close();
      }
    },
    90_000,
  );

  it("offers Pin for an activated promotion and leaves its row unmarked", async () => {
    const { context, page, gateway } = await openHandoffPage(
      VIEWPORTS[0],
      "promoted-requester",
      undefined,
      false,
      {
        // The stored entry keeps spawnedBy; the Gateway's pin verdict is the activated promotion.
        row: { spawnedBy: "agent:main:main", pinnable: true },
        methods: ["sessions.patch"],
      },
    );
    try {
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await row.locator(".sidebar-recent-session__name").waitFor();
      expect(await row.locator(".sidebar-session-promotion-tick").count()).toBe(0);
      await row.click({ button: "right" });
      const menu = page.locator("openclaw-session-menu");
      const pin = menu.locator('wa-dropdown-item[value="toggle-pin"]');
      await pin.waitFor({ state: "visible" });
      expect(await pin.getAttribute("disabled")).toBeNull();
      await pin.click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.patch")).map((request) =>
            requireRecord(requireRecord(request).params),
          ),
        )
        .toEqual([expect.objectContaining({ key, pinned: true })]);
      await captureUiProof(suite, page, "session-promotion-activated-pin.png");
    } finally {
      await context.close();
    }
  }, 90_000);
});
