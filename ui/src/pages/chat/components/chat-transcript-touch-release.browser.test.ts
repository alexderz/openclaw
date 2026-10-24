import { LitElement, html } from "lit";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

// DER-622 follow-up: when a finger scroll stops, the line being read stays put.
type Row = { key: string; height: number };

class TouchFixture extends LitElement {
  // The reader is away from the end, reading an older answer.
  readonly transcript = new ChatTranscriptController(this, () => "touch-release-browser", {
    canFollowEnd: () => false,
  });
  rows: Row[] = Array.from({ length: 40 }, (_, index) => ({ key: `m-${index}`, height: 180 }));

  protected override createRenderRoot() {
    return this;
  }

  protected override render() {
    const rows: TranscriptRow<Row>[] = this.rows.map((item) => ({
      kind: "item",
      key: `row:${item.key}`,
      item,
    }));
    const messageRows = new Map(this.rows.map((item) => [item.key, `row:${item.key}`]));
    return html`
      <div class="chat-thread-viewport" style="height: 500px; flex: none; padding: 0">
        <div class="chat-thread" style="overflow-anchor: none">
          ${this.transcript.renderSession("agent:main:touch-release", (session) => {
            session.setContentReady(true);
            session.syncMessageRows(messageRows, messageRows);
            return session.render(
              rows,
              (row) =>
                row.kind === "item"
                  ? html`<div
                      class="chat-bubble"
                      data-message-id=${row.item.key}
                      style=${`height: ${row.item.height}px`}
                    >
                      ${row.item.key}
                    </div>`
                  : null,
              null,
              false,
            );
          })}
        </div>
      </div>
    `;
  }
}
customElements.define("test-transcript-touch-release", TouchFixture);

let fixture: TouchFixture | undefined;
afterEach(() => {
  fixture?.remove();
  fixture = undefined;
});

const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

async function settleFrames(count = 4) {
  for (let index = 0; index < count; index++) {
    await frame();
    await fixture?.updateComplete;
  }
}

async function mountReader() {
  await page.viewport(1200, 900);
  const host = new TouchFixture();
  fixture = host;
  host.style.cssText = "display: block; width: 800px";
  document.body.append(host);
  await host.updateComplete;
  await settleFrames();
  const thread = host.querySelector<HTMLElement>(".chat-thread")!;
  thread.scrollTop = 2_000;
  await settleFrames(8);
  return { host, thread };
}

function touch(thread: HTMLElement, type: "touchstart" | "touchend") {
  const point = new Touch({ identifier: 1, target: thread, clientX: 100, clientY: 200 });
  thread.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      touches: type === "touchstart" ? [point] : [],
      changedTouches: [point],
    }),
  );
}

/** A finger dragging toward the latest messages, one native step per frame. */
async function dragDown(thread: HTMLElement, distance: number, step = 30) {
  for (let moved = 0; moved < distance; moved += step) {
    thread.scrollTop += step;
    await frame();
  }
}

/** Where a bubble sits in the viewport, by id, re-resolved every read. */
function bubbleTop(thread: HTMLElement, id: string) {
  const bubble = thread.querySelector<HTMLElement>(`.chat-bubble[data-message-id="${id}"]`);
  return bubble ? bubble.getBoundingClientRect().top - thread.getBoundingClientRect().top : null;
}

/** The first bubble whose top is inside the viewport. */
function readerBubble(thread: HTMLElement) {
  const top = thread.getBoundingClientRect().top;
  return [...thread.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")].find(
    (element) => element.getBoundingClientRect().top >= top,
  )!.dataset.messageId!;
}

/** The run streams one more row at the end while the reader holds a finger down. */
function streamRow(host: TouchFixture, key: string) {
  host.rows = [...host.rows, { key, height: 180 }];
  host.requestUpdate();
}

/** A row the reader already passed grows: its work group measures, an image loads. */
function growPassedRow(host: TouchFixture, thread: HTMLElement) {
  const passed = host.rows.findLast((row) => (bubbleTop(thread, row.key) ?? 0) < -200)!;
  host.rows = host.rows.map((row) => (row.key === passed.key ? { ...row, height: 420 } : row));
  host.requestUpdate();
}

it("leaves the reader's line where it is when the finger lifts after reading past a row that grew", async () => {
  const { host, thread } = await mountReader();
  touch(thread, "touchstart");
  // The live run changes the projection while the question is on screen.
  streamRow(host, "live-1");
  await settleFrames(2);
  // The reader drags down into the answer, past the question.
  await dragDown(thread, 900);
  await settleFrames(2);
  growPassedRow(host, thread);
  await settleFrames(4);
  const reading = readerBubble(thread);
  const before = bubbleTop(thread, reading)!;
  touch(thread, "touchend");
  await settleFrames(12);
  expect(bubbleTop(thread, reading)).toBe(before);
});

/**
 * Momentum after the finger lifts: each frame must move the text by exactly
 * the native step. Returns every frame where something else moved it too.
 */
async function fling(thread: HTMLElement, distance: number, step = 30) {
  const jumps: string[] = [];
  for (let moved = 0; moved < distance; moved += step) {
    const id = readerBubble(thread);
    const before = bubbleTop(thread, id)!;
    thread.scrollTop += step;
    await settleFrames(1);
    const after = bubbleTop(thread, id);
    if (after !== null && Math.abs(after - (before - step)) > 1) {
      jumps.push(`${id}: ${before} -> ${after}`);
    }
  }
  return jumps;
}

it("moves the transcript only with the fling after the finger lifts", async () => {
  const { host, thread } = await mountReader();
  touch(thread, "touchstart");
  streamRow(host, "live-1");
  await settleFrames(2);
  await dragDown(thread, 600);
  growPassedRow(host, thread);
  await settleFrames(2);
  // Released with momentum: the transcript keeps moving without the finger.
  touch(thread, "touchend");
  const jumps = await fling(thread, 300);
  const reading = readerBubble(thread);
  const before = bubbleTop(thread, reading)!;
  thread.dispatchEvent(new Event("scrollend"));
  await settleFrames(12);
  expect(jumps).toEqual([]);
  expect(bubbleTop(thread, reading)).toBe(before);
});
