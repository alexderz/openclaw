import type { Page } from "playwright";
import { expect, it } from "vitest";
import { promotionProjection } from "../lib/sessions/session-promotion.test-support.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const key = "agent:main:dashboard:turn-marker-proof";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900, scale: 1, touch: false },
  { name: "mobile-320", width: 320, height: 844, scale: 1, touch: true },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

/** Older unstamped turn, a delegated turn, an ordinary one: only the delegated turn is marked. */
function stampedHistory() {
  const at = Date.now() - 60_000;
  const user = (id: string, seq: number, text: string, authorityClass?: string) => ({
    role: "user",
    content: text,
    timestamp: at + seq * 1_000,
    __openclaw: { id, seq, ...(authorityClass ? { authorityClass } : {}) },
  });
  const reply = (id: string, seq: number, text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: at + seq * 1_000,
    __openclaw: { id, seq },
  });
  return {
    sessionKey: key,
    sessionId: `session:${key}`,
    messages: [
      user("older", 1, "Started before turns were stamped."),
      reply("reply-1", 2, "Noted."),
      user("delegated", 3, "Check the release notes and summarize the open risks.", "delegated"),
      reply("reply-2", 4, "I can't message other sessions from here, so here is the summary."),
      user("ordinary", 5, "Thanks, that's enough for today.", "ordinary"),
    ],
    pendingInputs: { items: [], total: 0 },
  };
}

const markerTools = {
  agentId: "main",
  profile: "coding",
  groups: [
    {
      id: "core",
      label: "Built-in tools",
      source: "core",
      tools: ["read", "write", "exec"].map((id) => ({
        id,
        label: id,
        description: "",
        rawDescription: "",
        source: "core",
      })),
    },
  ],
  restrictions: {
    evaluatedClass: "delegated",
    limitedTools: [
      { id: "browser", origins: ["inherited-limit"] },
      { id: "sessions_spawn", origins: ["subagent-layer"] },
    ],
    sessionsSend: "denied",
    evaluatedAt: 1,
  },
};

async function openMarkerPage(
  viewport: Viewport,
  colorScheme: "light" | "dark",
  history: Record<string, unknown>,
) {
  const context = await suite.browser.newContext({
    colorScheme,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.scale,
    hasTouch: viewport.touch,
    locale: "en-US",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  await installMockGateway(page, {
    sessionKey: key,
    operatorScopes: ["operator.read", "operator.write", "operator.admin"],
    featureMethods: ["chat.metadata", "chat.startup", "sessions.promote", "tools.effective"],
    methodResponses: {
      "sessions.list": sessionsListResponse([
        {
          ...sessionRow(key, "Handoff candidate", Date.now()),
          promotion: { ...promotionProjection("authorized-none"), classScope: "all-turns" },
        },
      ]),
      "chat.startup": history,
      "chat.history": history,
      "tools.effective": markerTools,
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
  return { context, page, host: page.locator("openclaw-chat-header-session-menu") };
}

/** The sheet slides in from the right; measure it only once it has come to rest. */
async function waitForSettledSheet(page: Page) {
  const sheet = page.locator(".session-settings");
  await sheet.waitFor({ state: "visible" });
  let previous = "";
  await expect
    .poll(async () => {
      const current = JSON.stringify(await sheet.boundingBox());
      const settled = current === previous;
      previous = current;
      return settled;
    })
    .toBe(true);
}

suite.define(() => {
  it.each(
    VIEWPORTS.flatMap((viewport) =>
      (["light", "dark"] as const).map((colorScheme) => ({
        viewport,
        colorScheme,
        label: `${viewport.name} ${colorScheme}`,
      })),
    ),
  )(
    "marks delegated turns with a quiet ! that opens Permissions: $label",
    async ({ viewport, colorScheme }) => {
      const history = stampedHistory();
      const { context, page, host } = await openMarkerPage(viewport, colorScheme, history);
      const name = `turn-marker-${viewport.name}-${colorScheme}`;
      try {
        const delegated = page.locator(".chat-group.user .chat-bubble", {
          hasText: "Check the release notes",
        });
        await delegated.waitFor();
        const markers = page.locator("openclaw-chat-turn-authority-marker");
        await expect.poll(() => markers.count()).toBe(1);
        expect(await delegated.locator("openclaw-chat-turn-authority-marker").count()).toBe(1);
        for (const text of ["Started before turns", "Thanks, that's enough"]) {
          const bubble = page.locator(".chat-group.user .chat-bubble", { hasText: text });
          expect(await bubble.locator("openclaw-chat-turn-authority-marker").count(), text).toBe(0);
        }
        const trigger = page.getByRole("button", {
          name: "Ran with delegated limits, not your normal permissions",
        });
        // Beside the bubble's corner: on screen, outside the text, and not a banner.
        const triggerBox = (await trigger.boundingBox())!;
        const bubbleBox = (await delegated.boundingBox())!;
        expect(triggerBox.x).toBeGreaterThanOrEqual(0);
        expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(bubbleBox.x + 1);
        expect(Math.abs(triggerBox.y - bubbleBox.y)).toBeLessThanOrEqual(8);
        expect(triggerBox.width).toBeLessThanOrEqual(24);
        // The bubble keeps its look: no border or tint for the delegated turn.
        const look = (bubble: typeof delegated) =>
          bubble.evaluate((element) => {
            const style = getComputedStyle(element);
            return [style.borderTopColor, style.backgroundColor, style.boxShadow];
          });
        expect(await look(delegated)).toEqual(
          await look(
            page.locator(".chat-group.user .chat-bubble", { hasText: "Thanks, that's enough" }),
          ),
        );
        // Selecting the turn's text never picks up the glyph.
        const selected = await delegated.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          const text = selection.toString();
          selection.removeAllRanges();
          return text;
        });
        expect(selected).toContain("Check the release notes");
        expect(selected).not.toContain("!");
        await captureUiProof(suite, page, name + ".png");

        if (viewport.touch) {
          await trigger.tap();
          // A tap on the marker opens it; it does not toggle the message's own actions.
          expect(await page.locator(".chat-group.user.chat-group--meta-revealed").count()).toBe(0);
        } else {
          await trigger.focus();
          await page.keyboard.press("Enter");
        }
        const popover = page.locator(".chat-turn-authority__panel");
        await popover.waitFor({ state: "visible" });
        await expect
          .poll(() => popover.locator(".chat-turn-authority__headline").textContent())
          .toContain("Now: Delegated · 2 extra limits · can't message other sessions");
        // First what this turn ran with, then the session as it is now.
        expect((await popover.locator("p").allTextContents()).map((text) => text.trim())).toEqual([
          "This message ran with delegated limits.",
          "Now: Delegated · 2 extra limits · can't message other sessions",
        ]);
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        expect(
          (await popover.locator("button").allTextContents()).map((text) => text.trim()),
        ).toEqual(["Open Session settings"]);
        const panelBox = (await popover.boundingBox())!;
        expect(panelBox.x).toBeGreaterThanOrEqual(0);
        expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
        await captureUiProof(suite, page, name + "-popover.png");

        await popover.getByRole("button", { name: "Open Session settings" }).click();
        await waitForSettledSheet(page);
        const permissions = page.locator('[data-section="permissions"]');
        await expect
          .poll(() => permissions.locator(".session-settings__headline").textContent())
          .toContain("Delegated · 2 extra limits · can't message other sessions");
        await expect.poll(() => popover.isVisible()).toBe(false);
        await captureUiProof(suite, page, name + "-settings.png");
        // Closing the sheet hands focus back to the marker that opened it.
        await page.keyboard.press("Escape");
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await host.count()).toBe(1);
      } catch (error) {
        await captureUiProof(suite, page, name + "-failure.png");
        throw error;
      } finally {
        await context.close();
      }
    },
    90_000,
  );
});
