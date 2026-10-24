import type { CDPSession, Page } from "playwright";
import { expect, it } from "vitest";
import {
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
  thread,
  touchDrag,
} from "./chat-reader-scroll.test-support.ts";

// DER-622 follow-up: a reader drags down from a steered question into its
// answer while the run is live. When the finger stops, the text stays put; it
// must not jump back up to the question.
const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";
const runId = "run-flint";
const QUESTION = "Then, how has the Flint model done?";
const base = 1_800_000_000_000;

function olderTurns(count: number) {
  const messages: unknown[] = [];
  let seq = 0;
  for (let turn = 0; turn < count; turn++) {
    const at = base + turn * 600_000;
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `Question ${turn}: ${"what about it ".repeat(3 + (turn % 4))}` },
      ],
      timestamp: at,
      __openclaw: { id: `u-${turn}`, seq: ++seq, idempotencyKey: `run-${turn}:user` },
    });
    messages.push({
      role: "assistant",
      content: [
        { type: "toolCall", id: `call-${turn}`, name: "exec", arguments: { command: "ls" } },
      ],
      timestamp: at + 1_000,
      __openclaw: { id: `c-${turn}`, seq: ++seq },
    });
    messages.push({
      role: "toolResult",
      toolCallId: `call-${turn}`,
      toolName: "exec",
      content: [{ type: "text", text: `out ${turn}` }],
      timestamp: at + 2_000,
      __openclaw: { id: `r-${turn}`, seq: ++seq },
    });
    messages.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Answer ${turn}: ${"the measured result reads well. ".repeat(8 + ((turn * 5) % 17))}`,
        },
      ],
      timestamp: at + 3_000,
      __openclaw: { id: `a-${turn}`, seq: ++seq },
    });
  }
  return { messages, seq };
}

function history() {
  const { messages, seq: start } = olderTurns(14);
  let seq = start;
  const at = base + 14 * 600_000;
  messages.push(
    {
      role: "user",
      content: [{ type: "text", text: "Run test 1 and the vision check." }],
      timestamp: at,
      __openclaw: { id: "u-run", seq: ++seq, idempotencyKey: `${runId}:user` },
    },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-run-1", name: "exec", arguments: { command: "bench" } },
      ],
      timestamp: at + 1_000,
      __openclaw: { id: "c-run-1", seq: ++seq },
    },
    {
      role: "toolResult",
      toolCallId: "call-run-1",
      toolName: "exec",
      content: [{ type: "text", text: "bench done" }],
      timestamp: at + 2_000,
      __openclaw: { id: "r-run-1", seq: ++seq },
    },
    {
      role: "user",
      content: [{ type: "text", text: QUESTION }],
      timestamp: at + 3_000,
      __openclaw: {
        id: "u-steer",
        seq: ++seq,
        idempotencyKey: "steer-1:user",
        steerTargetRunId: runId,
      },
    },
    // The answer arrives as several messages, as a working run reports.
    ...Array.from({ length: 8 }, (_, part) => ({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Flint answer ${part + 1}: ${"Flint held its prefill rate and decode stayed flat. ".repeat(12)}`,
        },
      ],
      timestamp: at + 4_000 + part,
      __openclaw: { id: `a-steer-${part}`, seq: ++seq },
    })),
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-run-2", name: "exec", arguments: { command: "bench 2" } },
      ],
      timestamp: at + 5_000,
      __openclaw: { id: "c-run-2", seq: seq + 1 },
    },
  );
  return messages;
}

async function openRunningChat() {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { width: 412, height: 915 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    historyMessages: history(),
    inFlightRun: { runId, text: "", startedAt: base + 14 * 600_000 },
    sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: sessionKey },
    sessionKey,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await page.locator(".chat-bubble", { hasText: QUESTION }).first().waitFor();
  await waitForChatScrollIdle(page);
  const cdp = await context.newCDPSession(page);
  return { context, page, gateway, cdp };
}

/** Put the steered question near the top, as a reader who just scrolled to it. */
async function readFromQuestion(page: Page, cdp: CDPSession) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const top = await thread(page).evaluate((element, question) => {
      const bubble = [
        ...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
      ].find((candidate) => candidate.textContent?.includes(question));
      return bubble
        ? bubble.getBoundingClientRect().top - element.getBoundingClientRect().top
        : null;
    }, QUESTION);
    if (top !== null && top > 40 && top < 260) {
      return top;
    }
    const dy = top === null ? 500 : Math.max(-500, Math.min(500, 150 - top));
    await touchDrag(page, cdp, dy, 12, 200);
    await waitForChatScrollIdle(page);
  }
  throw new Error("could not place the question near the top");
}

/** A follow-up from another device lands at the end while the reader is far above it. */
async function receiveFollowUp(gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  const seq = history().length + 1;
  const message = {
    role: "user",
    content: [{ type: "text", text: "And the mini model?" }],
    timestamp: Date.now(),
    __openclaw: { id: "u-mini", seq, idempotencyKey: "steer-2:user", steerTargetRunId: runId },
  };
  await gateway.emitGatewayEvent("session.message", {
    activeRunIds: [runId],
    clientRunId: "steer-2",
    hasActiveRun: true,
    message,
    messageId: "u-mini",
    messageSeq: seq,
    session: {
      activeRunIds: [runId],
      hasActiveRun: true,
      key: sessionKey,
      kind: "direct",
      status: "running",
      updatedAt: Date.now(),
    },
    sessionKey,
  });
}

suite.define(() => {
  for (const variant of [
    { name: "slow drag, finger rests, then release", steps: 40, hold: 300, grow: "drag" },
    { name: "drag released with momentum", steps: 8, hold: 0, grow: "drag" },
    {
      name: "fling, a passed message finishing its layout in the momentum",
      steps: 8,
      hold: 0,
      grow: "fling",
    },
  ] as const) {
    it(`holds the reader's line through a ${variant.name} (Report 2)`, async () => {
      const { context, page, gateway, cdp } = await openRunningChat();
      try {
        await readFromQuestion(page, cdp);
        await startRecorder(page);
        let grown = false;
        const grow = async () => {
          grown = await growPassedBubble(page);
        };
        // Drag the content up: the reader moves down into the answer.
        await touchDrag(page, cdp, -520, variant.steps, variant.hold, {
          0.25: () => receiveFollowUp(gateway),
          ...(variant.grow === "drag" ? { 0.75: grow } : {}),
        });
        if (variant.grow === "fling") {
          await page.waitForTimeout(32);
          await grow();
        }
        await page.waitForTimeout(2_000);
        const { release, jumps } = jumpsAgainstReader(await stopRecorder(page));
        expect(grown).toBe(true);
        expect(release).toBeGreaterThan(0);
        expect(jumps).toEqual([]);
      } finally {
        await suite.closeBrowserContext(context);
      }
    });
  }
});
