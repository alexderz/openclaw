import assert from "node:assert/strict";
import { scrollTopForCaretLine } from "../ui/src/pages/chat/components/composer-caret.ts";

assert.equal(
  scrollTopForCaretLine({
    scrollTop: 0,
    scrollHeight: 76,
    clientHeight: 32,
    caretTop: 48,
    caretBottom: 72,
  }),
  40,
);
assert.equal(
  scrollTopForCaretLine({
    scrollTop: 40,
    scrollHeight: 76,
    clientHeight: 32,
    caretTop: 48,
    caretBottom: 72,
  }),
  40,
);
assert.equal(
  scrollTopForCaretLine({
    scrollTop: 40,
    scrollHeight: 76,
    clientHeight: 32,
    caretTop: 0,
    caretBottom: 24,
  }),
  0,
);
assert.equal(
  scrollTopForCaretLine({
    scrollTop: 0,
    scrollHeight: 32,
    clientHeight: 32,
    caretTop: 48,
    caretBottom: 72,
  }),
  0,
);
console.log("composer caret scroll math ok");
