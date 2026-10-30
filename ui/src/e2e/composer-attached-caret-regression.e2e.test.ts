import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Attached short-pane caret" });
const draft =
  "FIRST LINE: This is an attached-image draft that wraps across the composer width and continues. SECOND LINE: More words keep wrapping below the visible first line. THIRD LINE: More typing should remain visible within the scrollable input. FOURTH LINE: We need to check the active cursor position and scrolling at the bottom. FIFTH LINE: The final marker is HERE.";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

suite.define(() => {
  it("keeps the actual active line visible with an image, but preserves deliberate draft scrolling", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 236 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.evaluate(() => document.fonts.ready);
        const input = page.locator(".agent-chat__composer-combobox textarea");
        await page
          .locator(".agent-chat__file-input")
          .setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: png });
        await page.locator(".chat-attachments-preview").waitFor({ state: "visible" });
        await input.fill(draft);
        const measure = () =>
          input.evaluate((el: HTMLTextAreaElement) => {
            const s = getComputedStyle(el),
              mirror = document.createElement("div");
            Object.assign(mirror.style, {
              position: "absolute",
              left: "-9999px",
              top: "0",
              visibility: "hidden",
              whiteSpace: "pre-wrap",
              overflowWrap: "break-word",
              boxSizing: "border-box",
              width: `${el.clientWidth}px`,
              lineHeight: s.lineHeight,
              padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
              border: "0",
            });
            for (const p of [
              "font-family",
              "font-size",
              "font-style",
              "font-weight",
              "font-stretch",
              "font-variant",
              "font-kerning",
              "font-feature-settings",
              "font-variation-settings",
              "letter-spacing",
              "word-spacing",
              "text-indent",
              "text-transform",
              "tab-size",
              "direction",
              "word-break",
            ])
              mirror.style.setProperty(p, s.getPropertyValue(p));
            mirror.append(document.createTextNode(el.value.slice(0, el.selectionEnd)));
            const marker = document.createElement("span");
            marker.textContent = "\u200b";
            mirror.append(marker);
            document.body.append(mirror);
            const rect = el.getBoundingClientRect();
            const actions = document
              .querySelector(".agent-chat__composer-footer")
              ?.getBoundingClientRect();
            const conversation = el.closest(".chat-main__conversation")?.getBoundingClientRect();
            const result = {
              top: marker.offsetTop,
              bottom: marker.offsetTop + marker.offsetHeight,
              scroll: el.scrollTop,
              visibleBottom: el.scrollTop + el.clientHeight,
              selection: el.selectionEnd,
              length: el.value.length,
              family: s.fontFamily,
              size: s.fontSize,
              lineHeight: s.lineHeight,
              width: el.clientWidth,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              inputTop: rect.top,
              inputBottom: rect.bottom,
              actionsTop: actions?.top,
              conversationHeight: conversation?.height,
              viewportHeight: innerHeight,
              fontReady: document.fonts.check(`${s.fontSize} "Instrument Sans"`),
            };
            mirror.remove();
            return result;
          });
        const assertVisible = async () => {
          const metrics = await measure();
          expect(metrics.family).toContain("Instrument Sans");
          expect(metrics.fontReady).toBe(true);
          expect(metrics.width).toBeGreaterThan(0);
          expect(metrics.conversationHeight).toBeLessThanOrEqual(200);
          expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
          expect(metrics.actionsTop).toBeDefined();
          expect(metrics.inputBottom).toBeLessThanOrEqual(metrics.actionsTop! + 1);
          expect(metrics.inputTop).toBeGreaterThanOrEqual(0);
          expect(metrics.inputBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
          expect(metrics.selection).toBe(metrics.length);
          expect(metrics.top).toBeGreaterThanOrEqual(metrics.scroll - 1);
          expect(metrics.bottom).toBeLessThanOrEqual(metrics.visibleBottom + 1);
        };
        await assertVisible();
        await input.evaluate((el: HTMLTextAreaElement) => {
          el.scrollTop = 0;
          el.dispatchEvent(new Event("scroll"));
          document.dispatchEvent(new Event("selectionchange"));
          window.visualViewport?.dispatchEvent(new Event("resize"));
        });
        await page.setViewportSize({ width: 390, height: 246 });
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
        expect(await input.evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBe(0);
        await input.press("x");
        expect(await input.evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBeGreaterThan(0);
        expect(await input.inputValue()).toBe(`${draft}x`);
        await assertVisible();
        for (let cycle = 0; cycle < 2; cycle++) {
          await page.locator(".chat-attachment-remove").click();
          await page
            .locator(".agent-chat__file-input")
            .setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: png });
          await page.locator(".chat-attachments-preview").waitFor({ state: "visible" });
          expect(await input.inputValue()).toBe(`${draft}x`);
          await assertVisible();
        }
      },
    );
  });
});
