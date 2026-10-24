import type { Page } from "playwright";
import { expect, it } from "vitest";
import { navigateToControlUiSession } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import {
  growPassedBubble,
  jumpsAgainstReader,
  startRecorder,
  stopRecorder,
  touchDrag,
} from "./chat-reader-scroll.test-support.ts";

// DER-622 (P7): a chat you return to shows the place you left, and Scroll to
// latest lands at the true bottom and stays there, through the re-entry read.
const suite = createChatFlowE2eSuite();
const molting = "agent:main:molting";
const other = "agent:main:mod-the-first";
const backing = `${molting}:backing`;

/** CLI-shaped history: stored replies with a sequence, imported tool rows without one. */
function transcript(count: number, start = 0) {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    const timestamp = 1_800_000_000_000 + index * 60_000;
    if (index % 5 === 4) {
      return {
        role: "assistant",
        content: [
          { type: "toolcall", id: `toolu-${index}`, name: "exec", arguments: { command: "ls" } },
          {
            type: "tool_result",
            tool_use_id: `toolu-${index}`,
            name: "exec",
            content: `output ${index}`,
          },
        ],
        timestamp,
        __openclaw: {
          id: `tool-${index}`,
          importedFrom: "claude-cli",
          externalId: `tool-${index}`,
        },
      };
    }
    return {
      role: index % 5 === 0 ? "user" : "assistant",
      content: `Message ${index}: ${"wrapped transcript content ".repeat(4 + ((index * 7) % 23))}`,
      timestamp,
      __openclaw: { id: `msg-${index}`, seq: index + 1 },
    };
  });
}

function historyCases(messages: unknown[], total: number) {
  return {
    cases: [
      {
        match: { sessionKey: molting },
        response: {
          messages,
          sessionId: backing,
          thinkingLevel: null,
          hasMore: true,
          nextOffset: messages.length,
          totalMessages: total,
        },
      },
      {
        match: { sessionKey: other },
        response: { messages: transcript(12), sessionId: `${other}:backing`, thinkingLevel: null },
      },
    ],
  };
}

async function openMolting() {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { width: 412, height: 915 },
    hasTouch: true,
    isMobile: true,
  });
  const browserPage = await context.newPage();
  const all = transcript(160);
  const shown = all.slice(40, 150);
  const gateway = await installMockGateway(browserPage, {
    methodResponses: {
      "chat.history": historyCases(shown, 150),
      "chat.startup": historyCases(shown, 150),
      "sessions.list": chatSessionListResponse([
        { key: molting, sessionId: backing, kind: "direct", label: "Molting", updatedAt: 2 },
        { key: other, sessionId: `${other}:backing`, kind: "direct", label: "Mod", updatedAt: 1 },
      ]),
    },
    sessionKey: molting,
  });
  await browserPage.goto(controlUiSessionUrl(suite.server.baseUrl, molting));
  await waitForChatScrollIdle(browserPage);
  return { context, page: browserPage, gateway, all };
}

const thread = (browserPage: Page) =>
  browserPage.locator(".chat-pane-cache__pane--visible .chat-thread");

async function viewport(browserPage: Page) {
  return thread(browserPage).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const bubble = [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")].find(
      (candidate) => candidate.getBoundingClientRect().bottom > top,
    );
    return {
      distance: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
      anchor: bubble?.dataset.messageId ?? null,
      offset: bubble ? Math.round(bubble.getBoundingClientRect().top - top) : null,
    };
  });
}

/** Read the transcript every frame for `frames`; report its largest distance from the end. */
async function farthestFromEnd(browserPage: Page, frames: number) {
  return thread(browserPage).evaluate(async (element, count) => {
    let farthest = 0;
    for (let frame = 0; frame < count; frame++) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      farthest = Math.max(
        farthest,
        element.scrollHeight - element.scrollTop - element.clientHeight,
      );
    }
    return Math.round(farthest);
  }, frames);
}

/** While the reader is away, the run ends and its rows are stored. */
async function runEndsWhileAway(
  gateway: Awaited<ReturnType<typeof openMolting>>["gateway"],
  all: unknown[],
) {
  await gateway.emitGatewayEvent("chat", {
    message: {
      content: [{ type: "text", text: "Message 152: the reply that ended while away" }],
      role: "assistant",
      timestamp: Date.now(),
    },
    runId: "run-while-away",
    sessionKey: molting,
    state: "final",
  });
  await gateway.setMethodResponse("chat.history", historyCases(all.slice(40, 155), 155));
}

async function scrollReaderUp(browserPage: Page) {
  await thread(browserPage).evaluate((element) => {
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 3);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await thread(browserPage).hover();
  await browserPage.mouse.wheel(0, -40);
  await waitForChatScrollIdle(browserPage);
  const left = await viewport(browserPage);
  expect(left.distance).toBeGreaterThan(2_000);
  return left;
}

async function tapScrollToLatest(browserPage: Page) {
  const button = browserPage.locator(".chat-pane-cache__pane--visible .chat-scroll-to-bottom");
  await expect.poll(() => button.getAttribute("data-visible")).toBe("true");
  await button.tap();
}

suite.define(() => {
  it("returns to the latest message after another chat, while the re-entry read is held", async () => {
    const { context, page: browserPage, gateway, all } = await openMolting();
    try {
      expect((await viewport(browserPage)).distance).toBeLessThanOrEqual(8);
      await navigateToControlUiSession(browserPage, other);
      await waitForChatScrollIdle(browserPage);
      await runEndsWhileAway(gateway, all);
      await gateway.deferNext("chat.history", { sessionKey: molting });
      await navigateToControlUiSession(browserPage, molting);
      expect(await farthestFromEnd(browserPage, 30)).toBeLessThanOrEqual(8);
      await gateway.resolveDeferred("chat.history");
      expect(await farthestFromEnd(browserPage, 60)).toBeLessThanOrEqual(8);
      await waitForChatScrollIdle(browserPage);
      await thread(browserPage)
        .locator(".chat-bubble")
        .getByText(/^Message 153:/)
        .waitFor();
      expect((await viewport(browserPage)).distance).toBeLessThanOrEqual(8);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("returns to the reader's place, then Scroll to latest lands at the bottom through the re-entry read", async () => {
    const { context, page: browserPage, gateway, all } = await openMolting();
    try {
      const left = await scrollReaderUp(browserPage);
      await navigateToControlUiSession(browserPage, other);
      await waitForChatScrollIdle(browserPage);
      await runEndsWhileAway(gateway, all);
      await gateway.deferNext("chat.history", { sessionKey: molting });
      await navigateToControlUiSession(browserPage, molting);
      await waitForChatScrollIdle(browserPage);
      const returned = await viewport(browserPage);
      expect(returned.anchor).toBe(left.anchor);
      expect(Math.abs((returned.offset ?? 0) - (left.offset ?? 0))).toBeLessThanOrEqual(2);
      await tapScrollToLatest(browserPage);
      // The re-entry read lands during the journey.
      await farthestFromEnd(browserPage, 3);
      await gateway.resolveDeferred("chat.history");
      await waitForChatScrollIdle(browserPage);
      expect((await viewport(browserPage)).distance).toBeLessThanOrEqual(8);
      expect(await farthestFromEnd(browserPage, 60)).toBeLessThanOrEqual(8);
      await thread(browserPage)
        .locator(".chat-bubble")
        .getByText(/^Message 153:/)
        .waitFor();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  /** Back in the chat at the reader's place, with the re-entry read still held. */
  async function returnWhileReadIsHeld(
    browserPage: Page,
    gateway: Awaited<ReturnType<typeof openMolting>>["gateway"],
    all: unknown[],
  ) {
    await scrollReaderUp(browserPage);
    await navigateToControlUiSession(browserPage, other);
    await waitForChatScrollIdle(browserPage);
    await runEndsWhileAway(gateway, all);
    await gateway.deferNext("chat.history", { sessionKey: molting });
    await navigateToControlUiSession(browserPage, molting);
    await waitForChatScrollIdle(browserPage);
    return browserPage.context().newCDPSession(browserPage);
  }

  it("moves only with the reader's fling while the re-entry read lands under it", async () => {
    const { context, page: browserPage, gateway, all } = await openMolting();
    try {
      const cdp = await returnWhileReadIsHeld(browserPage, gateway, all);
      await startRecorder(browserPage);
      let grown = false;
      // The stored rows replace the live ones, then one the reader passed finishes its layout.
      await touchDrag(browserPage, cdp, -500, 8, 0, {
        0.25: () => gateway.resolveDeferred("chat.history"),
        0.75: async () => {
          grown = await growPassedBubble(browserPage);
        },
      });
      await browserPage.waitForTimeout(1_500);
      // A re-read that commits under the moving finger can still shift the text
      // mid-drag (DER-622 follow-up); this guards that release adds no jump.
      const { release, rest, jumps } = jumpsAgainstReader(await stopRecorder(browserPage), {
        fromRelease: true,
      });
      expect(grown).toBe(true);
      expect(release).toBeGreaterThan(0);
      expect(rest, "scrolling never came to rest").toBeGreaterThanOrEqual(release);
      expect(jumps).toEqual([]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("lands at the bottom when Scroll to latest is tapped during a fling, as the re-entry read lands", async () => {
    const { context, page: browserPage, gateway, all } = await openMolting();
    try {
      const cdp = await returnWhileReadIsHeld(browserPage, gateway, all);
      await touchDrag(browserPage, cdp, -500, 8, 0);
      await tapScrollToLatest(browserPage);
      await gateway.resolveDeferred("chat.history");
      await waitForChatScrollIdle(browserPage);
      expect((await viewport(browserPage)).distance).toBeLessThanOrEqual(8);
      expect(await farthestFromEnd(browserPage, 60)).toBeLessThanOrEqual(8);
      await thread(browserPage)
        .locator(".chat-bubble")
        .getByText(/^Message 153:/)
        .waitFor();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("returns to the reader's place from the background, then Scroll to latest lands at the bottom", async () => {
    const { context, page: browserPage, gateway, all } = await openMolting();
    try {
      const left = await scrollReaderUp(browserPage);
      const setVisibility = (state: "hidden" | "visible") =>
        browserPage.evaluate((next) => {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: next });
          Object.defineProperty(document, "hidden", {
            configurable: true,
            value: next === "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        }, state);
      await setVisibility("hidden");
      await runEndsWhileAway(gateway, all);
      const reads = await gateway.deferNext("chat.history", { sessionKey: molting });
      await setVisibility("visible");
      await gateway.waitForRequest("chat.history", {
        after: reads,
        match: { sessionKey: molting },
      });
      await waitForChatScrollIdle(browserPage);
      const returned = await viewport(browserPage);
      expect(returned.anchor).toBe(left.anchor);
      expect(Math.abs((returned.offset ?? 0) - (left.offset ?? 0))).toBeLessThanOrEqual(2);
      await tapScrollToLatest(browserPage);
      await farthestFromEnd(browserPage, 3);
      await gateway.resolveDeferred("chat.history");
      await waitForChatScrollIdle(browserPage);
      expect((await viewport(browserPage)).distance).toBeLessThanOrEqual(8);
      expect(await farthestFromEnd(browserPage, 60)).toBeLessThanOrEqual(8);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("lands at the latest message after Reload and holds it through the full read", async () => {
    const { context, page: browserPage } = await openMolting();
    try {
      await scrollReaderUp(browserPage);
      await browserPage.reload();
      await waitForChatScrollIdle(browserPage);
      await thread(browserPage)
        .locator(".chat-bubble")
        .getByText(/^Message 148:/)
        .waitFor();
      expect((await viewport(browserPage)).distance).toBeLessThanOrEqual(8);
      expect(await farthestFromEnd(browserPage, 60)).toBeLessThanOrEqual(8);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
