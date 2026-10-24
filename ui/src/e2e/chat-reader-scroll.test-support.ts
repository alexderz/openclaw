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
    // Read each frame as painted: after its layout and resize-observer
    // compensation, not in requestAnimationFrame before them.
    const afterPaint = () => setTimeout(record, 0);
    const record = () => {
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
      requestAnimationFrame(afterPaint);
    };
    requestAnimationFrame(afterPaint);
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
 * Frames where the text moved against a drag toward the latest messages
 * (back toward older ones), during the gesture or after it; moved at all
 * once scrolling settled; or was replaced so its movement cannot be read.
 */
export function jumpsAgainstReader(frames: Frame[]) {
  const release = frames.findIndex((frame) => frame.events?.includes("touchend"));
  let settle = release;
  for (let index = Math.max(release, 0); index < frames.length; index++) {
    if (frames[index]!.events?.includes("scrollend")) {
      settle = index;
    }
  }
  const jumps: string[] = [];
  for (let index = 1; index < frames.length; index++) {
    const previous = new Map(frames[index - 1]!.bubbles);
    const shared = frames[index]!.bubbles.filter(([id]) => previous.has(id));
    const [id, y] = shared.toSorted((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0] ?? [];
    if (id === undefined || y === undefined) {
      jumps.push(`frame ${index}: no bubble shared with the previous frame`);
      continue;
    }
    const shift = y - previous.get(id)!;
    if (shift > 1 || (release >= 0 && index > settle && Math.abs(shift) > 1)) {
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

/**
 * Late layout in a message the reader already passed, whose whole row is
 * above the screen: an image, a table, highlighted code. Returns whether
 * such a message was on hand to grow.
 */
export async function growPassedBubble(page: Page): Promise<boolean> {
  return thread(page).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const passed = [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")]
      .toReversed()
      .find(
        (bubble) =>
          (bubble.closest(".chat-virtual-row") ?? bubble).getBoundingClientRect().bottom < top - 20,
      );
    if (passed) {
      passed.style.paddingBottom = "260px";
    }
    return passed !== undefined;
  });
}
