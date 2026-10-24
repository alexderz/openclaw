import type { CDPSession, Page } from "playwright";

// DER-622 follow-up: watch the transcript every frame through a real touch
// gesture, to prove nothing but the finger (or its fling) moves the text.

type Frame = { scrollTop: number; bubbles: [string, number][]; events?: string };
type Recorder = { frames: Frame[]; stopped: boolean };
type RecorderWindow = Window & { chatReaderScrollRecorder?: Recorder };

export const thread = (page: Page) => page.locator(".chat-pane-cache__pane--visible .chat-thread");

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Record every frame: scroll offset, gesture events, and where each bubble sits. */
export async function startRecorder(page: Page) {
  await thread(page).evaluate((element) => {
    const recorder: Recorder = { frames: [], stopped: false };
    (window as RecorderWindow).chatReaderScrollRecorder = recorder;
    let events: string | undefined;
    for (const type of ["touchstart", "touchend", "scrollend"]) {
      element.addEventListener(
        type,
        () => {
          events = events ? `${events},${type}` : type;
        },
        { passive: true },
      );
    }
    const tick = () => {
      if (recorder.stopped) {
        return;
      }
      const top = element.getBoundingClientRect().top;
      const bubbles = [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")]
        .map(
          (bubble) =>
            [bubble.dataset.messageId!, bubble.getBoundingClientRect().top - top] as [
              string,
              number,
            ],
        )
        .filter(([, y]) => y > -3000 && y < 3000);
      recorder.frames.push({ scrollTop: element.scrollTop, bubbles, events });
      events = undefined;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function stopRecorder(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const recorder = (window as RecorderWindow).chatReaderScrollRecorder!;
    recorder.stopped = true;
    return recorder.frames;
  });
}

/**
 * Frames from the finger lifting onward where the text moved against the
 * drag (back toward older messages), or moved at all once scrolling settled.
 */
export function jumpsAfterRelease(frames: Frame[]) {
  const release = frames.findIndex((frame) => frame.events?.includes("touchend"));
  let settle = release;
  for (let index = release; index < frames.length; index++) {
    if (frames[index]!.events?.includes("scrollend")) {
      settle = index;
    }
  }
  const jumps: string[] = [];
  for (let index = Math.max(release, 1); index < frames.length; index++) {
    const previous = new Map(frames[index - 1]!.bubbles);
    const shared = frames[index]!.bubbles.filter(([id]) => previous.has(id));
    const [id, y] = shared.toSorted((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0] ?? [];
    if (id === undefined || y === undefined) {
      continue;
    }
    const shift = y - previous.get(id)!;
    if (shift > 1 || (index > settle && Math.abs(shift) > 1)) {
      jumps.push(
        `frame ${index}: ${id} moved ${Math.round(shift)}px, scrollTop ${Math.round(frames[index - 1]!.scrollTop)} -> ${Math.round(frames[index]!.scrollTop)}`,
      );
    }
  }
  return { release, jumps };
}

/**
 * A real finger: touchstart, one move per frame, an optional rest, then lift.
 * `during` runs work after the move at that fraction of the drag.
 */
export async function touchDrag(
  page: Page,
  cdp: CDPSession,
  dy: number,
  steps: number,
  holdMs: number,
  during: Record<number, () => Promise<void>> = {},
) {
  const box = (await thread(page).boundingBox())!;
  const x = Math.round(box.x + box.width / 2);
  const startY = Math.round(dy > 0 ? box.y + 80 : box.y + box.height - 80);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: startY }],
  });
  for (let step = 1; step <= steps; step++) {
    await sleep(16);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: Math.round(startY + (dy * step) / steps) }],
    });
    await during[step / steps]?.();
  }
  if (holdMs > 0) {
    await sleep(holdMs);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Late layout in a message the reader already passed: an image, a table, highlighted code. */
export async function growPassedBubble(page: Page) {
  await thread(page).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const passed = [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")]
      .toReversed()
      .find((bubble) => bubble.getBoundingClientRect().bottom < top - 20);
    if (passed) {
      passed.style.paddingBottom = "260px";
    }
  });
}
