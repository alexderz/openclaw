import { LitElement, html } from "lit";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

// DER-622: Scroll to latest lands at the true bottom, whatever the rows do on the way.
type Row = { key: string; height: number };

const rowsFrom = (prefix: string, count: number, height = 180): Row[] =>
  Array.from({ length: count }, (_, index) => ({ key: `${prefix}-${index}`, height }));

class JumpFixture extends LitElement {
  following = false;
  readonly transcript = new ChatTranscriptController(this, () => "jump-to-latest-browser", {
    canFollowEnd: () => this.following,
  });
  rows: Row[] = rowsFrom("m", 40);

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
          ${this.transcript.renderSession("agent:main:jump-to-latest", (session) => {
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
customElements.define("test-transcript-jump-to-latest", JumpFixture);

let fixture: JumpFixture | undefined;
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

async function mountReader() {
  await page.viewport(1200, 900);
  const host = new JumpFixture();
  fixture = host;
  host.style.cssText = "display: block; width: 800px";
  document.body.append(host);
  await host.updateComplete;
  await settleFrames();
  const thread = host.querySelector<HTMLElement>(".chat-thread")!;
  // The reader is near the top of the loaded window, where older history loads.
  thread.scrollTop = 400;
  await settleFrames(8);
  return { host, thread };
}

/** Wait for the smooth journey to come to rest. */
async function settleScroll(thread: HTMLElement) {
  let still = 0;
  let last = thread.scrollTop;
  for (let frame = 0; frame < 400 && still < 10; frame++) {
    await settleFrames(1);
    still = thread.scrollTop === last ? still + 1 : 0;
    last = thread.scrollTop;
  }
}

const distanceFromEnd = (thread: HTMLElement) =>
  thread.scrollHeight - thread.scrollTop - thread.clientHeight;

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

/** The reader taps Scroll to latest, which travels smoothly. */
function jumpToLatest(host: JumpFixture) {
  host.following = true;
  host.transcript.scrollToEnd({ source: "manual", behavior: "smooth" });
  host.requestUpdate();
}

it("lands at the true bottom when held older history commits during the journey", async () => {
  const { host, thread } = await mountReader();
  // A fling holds the arriving older page back while the transcript still moves.
  touch(thread, "touchstart");
  thread.scrollTop -= 40;
  await settleFrames(2);
  host.rows = [...rowsFrom("older", 60), ...host.rows];
  host.requestUpdate();
  await settleFrames(2);
  expect(thread.querySelector<HTMLElement>(".chat-bubble")?.dataset.messageId).toBe("m-0");
  touch(thread, "touchend");
  // The held page commits as soon as the command owns the viewport.
  jumpToLatest(host);
  await settleScroll(thread);
  expect(distanceFromEnd(thread)).toBeLessThanOrEqual(8);
  expect(thread.querySelector(".chat-bubble[data-message-id='m-39']")).not.toBeNull();
});

it("lands at the true bottom when rows land above and below during the journey", async () => {
  const { host, thread } = await mountReader();
  jumpToLatest(host);
  await settleFrames(3);
  // The rows must land while the journey is still on its way.
  expect(distanceFromEnd(thread)).toBeGreaterThan(1_000);
  // A re-read admits earlier rows and the reply that ended while the reader was away.
  host.rows = [...rowsFrom("older", 30), ...host.rows, ...rowsFrom("late", 3, 400)];
  host.requestUpdate();
  await settleScroll(thread);
  expect(distanceFromEnd(thread)).toBeLessThanOrEqual(8);
  expect(thread.querySelector(".chat-bubble[data-message-id='late-2']")).not.toBeNull();
});

it("stays at the bottom after landing while the re-read replaces rows", async () => {
  const { host, thread } = await mountReader();
  jumpToLatest(host);
  await settleScroll(thread);
  expect(distanceFromEnd(thread)).toBeLessThanOrEqual(8);
  // The re-read swaps live copies for stored rows of other sizes and keys.
  host.rows = [...rowsFrom("older", 10), ...host.rows.slice(0, 36), ...rowsFrom("stored", 4, 260)];
  host.requestUpdate();
  await settleFrames(30);
  expect(distanceFromEnd(thread)).toBeLessThanOrEqual(8);
  expect(thread.querySelector(".chat-bubble[data-message-id='stored-3']")).not.toBeNull();
});
