import assert from "node:assert/strict";
import {
  activeCaretOffset,
  scrollTopForCaretLine,
  shouldFollowCaret,
  shouldRevealOnViewportResize,
  viewportPanDelta,
} from "../ui/src/pages/chat/components/composer-caret.ts";

assert.equal(shouldFollowCaret(20, 20), false);
assert.equal(shouldFollowCaret(20, 21), true);
assert.equal(shouldRevealOnViewportResize(true, false), false);
assert.deepEqual(
  viewportPanDelta({ offsetTop: 30, offsetLeft: 4 }, { offsetTop: 12, offsetLeft: 4 }),
  { dx: 0, dy: 18 },
);

assert.equal(activeCaretOffset({ start: 4, end: 20, direction: "backward", valueLength: 40 }), 4);
assert.equal(activeCaretOffset({ start: 4, end: 20, direction: "forward", valueLength: 40 }), 20);
assert.equal(activeCaretOffset({ start: 11, end: 11, direction: "none", valueLength: 40 }), 11);
assert.equal(
  scrollTopForCaretLine({
    scrollTop: 0,
    scrollHeight: 200,
    clientHeight: 32,
    caretTop: 96,
    caretBottom: 120,
  }),
  88,
);
assert.equal(
  scrollTopForCaretLine({
    scrollTop: 88,
    scrollHeight: 200,
    clientHeight: 32,
    caretTop: 96,
    caretBottom: 120,
  }),
  88,
);
console.log("composer caret scroll math ok");
