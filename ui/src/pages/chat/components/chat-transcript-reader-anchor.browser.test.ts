import { LitElement, html } from "lit";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";

// DER-615: while the reader is scrolled up, nothing moves the text they read.
type ReaderRow = { key: string; workHeight: number; bubbleHeight: number; body?: unknown };

class ReaderFixture extends LitElement {
  // The reader has scrolled away from the end; the chat must not follow.
  readonly transcript = new ChatTranscriptController(this, () => "reader-anchor-browser", {
    canFollowEnd: () => false,
  });
  rows: ReaderRow[] = Array.from({ length: 40 }, (_, index) => ({
    key: `m-${index}`,
    workHeight: 0,
    bubbleHeight: 180,
  }));

  protected override createRenderRoot() {
    return this;
  }

  protected override render() {
    const rows: TranscriptRow<ReaderRow>[] = this.rows.map((item) => ({
      kind: "item",
      key: `row:${item.key}`,
      item,
    }));
    const messageRows = new Map(this.rows.map((item) => [item.key, `row:${item.key}`]));
    return html`
      <div class="chat-thread-viewport" style="height: 500px; flex: none; padding: 0">
        <div class="chat-thread" style="overflow-anchor: none">
          ${this.transcript.renderSession("agent:main:reader-anchor", (session) => {
            if (!(session instanceof ChatSessionVirtualizerHost)) {
              throw new Error("Expected the session virtualizer owner");
            }
            session.setContentReady(true);
            session.syncMessageRows(messageRows, messageRows);
            return session.render(
              rows,
              (row) =>
                row.kind === "item"
                  ? html`<div>
                      <div class="work" style=${`height: ${row.item.workHeight}px`}></div>
                      <div
                        class="chat-bubble"
                        data-message-id=${row.item.key}
                        style=${row.item.bubbleHeight ? `height: ${row.item.bubbleHeight}px` : ""}
                      >
                        ${row.item.body ?? row.item.key}
                      </div>
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
customElements.define("test-transcript-reader-anchor", ReaderFixture);

let fixture: ReaderFixture | undefined;
afterEach(() => {
  fixture?.remove();
  fixture = undefined;
});

async function settleFrames(count = 4) {
  for (let frame = 0; frame < count; frame++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await fixture?.updateComplete;
  }
}

async function mountReader(workHeight = 0) {
  await page.viewport(1200, 900);
  const host = new ReaderFixture();
  host.rows = host.rows.map((row) => ({ ...row, workHeight }));
  fixture = host;
  host.style.cssText = "display: block; width: 800px";
  document.body.append(host);
  await host.updateComplete;
  await settleFrames();
  const thread = host.querySelector<HTMLElement>(".chat-thread")!;
  // Park the reader in the middle of the transcript.
  thread.scrollTop = 3_000;
  await settleFrames(8);
  return { host, thread };
}

/** The first bubble whose top is inside the viewport, and where it sits. */
function readerTarget(thread: HTMLElement) {
  const top = thread.getBoundingClientRect().top;
  const bubble = [...thread.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")].find(
    (element) => element.getBoundingClientRect().top >= top,
  )!;
  const id = bubble.dataset.messageId!;
  const offset = () =>
    thread
      .querySelector<HTMLElement>(`.chat-bubble[data-message-id="${id}"]`)!
      .getBoundingClientRect().top - thread.getBoundingClientRect().top;
  return { id, offset, start: offset() };
}

it("holds the text being read when a row above grows while the reader scrolls up", async () => {
  const { thread } = await mountReader();
  // Scrolling up: virtual-core's default skips re-measured rows in this direction.
  thread.scrollTop -= 60;
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  const target = readerTarget(thread);
  // A late image or embed: the DOM grows without a new projection.
  const above = [...thread.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")].find(
    (element) => element.getBoundingClientRect().bottom < thread.getBoundingClientRect().top,
  )!;
  above.style.height = "480px";
  await settleFrames(8);
  expect(Math.abs(target.offset() - target.start)).toBeLessThanOrEqual(1);
});

it("holds the bubble being read when its row's content above it collapses", async () => {
  const { host, thread } = await mountReader(300);
  // Put the viewport top inside one row's work, above that row's bubble.
  const first = readerTarget(thread);
  const firstRow = thread
    .querySelector<HTMLElement>(`.chat-bubble[data-message-id="${first.id}"]`)!
    .closest<HTMLElement>(".chat-virtual-row")!;
  thread.scrollTop +=
    firstRow.getBoundingClientRect().top - thread.getBoundingClientRect().top + 100;
  await settleFrames(8);
  const target = readerTarget(thread);
  expect(target.id).toBe(first.id);
  // A settled run folds its tool cards in place: same row, new content.
  host.rows = host.rows.map((row) => (row.key === target.id ? { ...row, workHeight: 40 } : row));
  host.requestUpdate();
  await settleFrames(8);
  expect(Math.abs(target.offset() - target.start)).toBeLessThanOrEqual(1);
});

it("holds the text being read when media above it loads inside the row spanning the viewport top", async () => {
  const { host, thread } = await mountReader(80);
  host.rows = host.rows.map((row) => ({ ...row, bubbleHeight: 700 }));
  host.requestUpdate();
  await settleFrames(8);
  // Read from the middle of one long bubble: its row starts above the viewport.
  const bubble = readerTarget(thread);
  const element = thread.querySelector<HTMLElement>(
    `.chat-bubble[data-message-id="${bubble.id}"]`,
  )!;
  thread.scrollTop +=
    element.getBoundingClientRect().top - thread.getBoundingClientRect().top + 200;
  await settleFrames(8);
  const start = element.getBoundingClientRect().top - thread.getBoundingClientRect().top;
  // An image above the paragraph, in the same row, finishes loading.
  element.previousElementSibling!.setAttribute("style", "height: 380px");
  await settleFrames(8);
  const after = element.getBoundingClientRect().top - thread.getBoundingClientRect().top;
  expect(Math.abs(after - start)).toBeLessThanOrEqual(1);
});

/** Put the viewport top `depth` px below `selector`'s top inside the target row. */
async function readInside(thread: HTMLElement, selector: string, depth: number) {
  const element = thread.querySelector<HTMLElement>(selector)!;
  thread.scrollTop +=
    element.getBoundingClientRect().top - thread.getBoundingClientRect().top + depth;
  await settleFrames(8);
  return element;
}

it("holds the text being read when media above and below it in one message load together", async () => {
  const { host, thread } = await mountReader();
  const target = readerTarget(thread);
  host.rows = host.rows.map((row) =>
    row.key === target.id
      ? {
          ...row,
          bubbleHeight: 0,
          body: html`<div class="media-above" style="height: 40px"></div>
            <div class="reading" style="height: 900px">Reading</div>
            <div class="media-below" style="height: 40px"></div>`,
        }
      : row,
  );
  host.requestUpdate();
  await settleFrames(8);
  const reading = await readInside(thread, ".reading", 300);
  const start = reading.getBoundingClientRect().top;
  thread.querySelector<HTMLElement>(".media-above")!.style.height = "340px";
  thread.querySelector<HTMLElement>(".media-below")!.style.height = "240px";
  await settleFrames(8);
  expect(Math.abs(reading.getBoundingClientRect().top - start)).toBeLessThanOrEqual(1);
});

it("holds the line being read when an inline image above it in the same paragraph loads", async () => {
  const { host, thread } = await mountReader();
  const target = readerTarget(thread);
  host.rows = host.rows.map((row) =>
    row.key === target.id
      ? {
          ...row,
          bubbleHeight: 0,
          body: html`<p class="para" style="margin: 0; line-height: 20px">
            <span
              class="inline-media"
              style="display: inline-block; width: 10px; height: 10px"
            ></span>
            ${"word ".repeat(1500)}
          </p>`,
        }
      : row,
  );
  host.requestUpdate();
  await settleFrames(8);
  await readInside(thread, ".para", 300);
  const viewport = thread.getBoundingClientRect();
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const caret = caretDocument.caretPositionFromPoint?.(viewport.left + 200, viewport.top + 30);
  const range = document.createRange();
  if (caret) {
    range.setStart(caret.offsetNode, caret.offset);
    range.setEnd(caret.offsetNode, caret.offset + 1);
  } else {
    const fallback = document.caretRangeFromPoint(viewport.left + 200, viewport.top + 30)!;
    range.setStart(fallback.startContainer, fallback.startOffset);
    range.setEnd(fallback.startContainer, fallback.startOffset + 1);
  }
  const start = range.getBoundingClientRect().top;
  thread.querySelector<HTMLElement>(".inline-media")!.style.height = "310px";
  await settleFrames(8);
  expect(Math.abs(range.getBoundingClientRect().top - start)).toBeLessThanOrEqual(2);
});

it("holds the text being read when new rows land after it", async () => {
  const { host, thread } = await mountReader();
  const target = readerTarget(thread);
  host.rows = [
    ...host.rows,
    ...Array.from({ length: 5 }, (_, index) => ({
      key: `late-${index}`,
      workHeight: 0,
      bubbleHeight: 300,
    })),
  ];
  host.requestUpdate();
  await settleFrames(8);
  expect(Math.abs(target.offset() - target.start)).toBeLessThanOrEqual(1);
});

it("holds the text being read when Show earlier prepends history", async () => {
  const { host, thread } = await mountReader();
  const target = readerTarget(thread);
  host.rows = [
    ...Array.from({ length: 10 }, (_, index) => ({
      key: `earlier-${index}`,
      workHeight: 0,
      bubbleHeight: 260,
    })),
    ...host.rows,
  ];
  host.requestUpdate();
  await settleFrames(8);
  expect(Math.abs(target.offset() - target.start)).toBeLessThanOrEqual(1);
});
