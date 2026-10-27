// The phone fix for "attached image with the keyboard open" lives in source CSS so the
// build carries it; losing it once left the draft invisible (DER-6xx). The same slot
// keeps a plain draft on screen too.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const MARKER = "--openclaw-composer-attachment-visible";
const CARET = "--openclaw-composer-caret-visible";

describe("composer attachment visibility", () => {
  const css = fs.readFileSync(path.join(stylesDir, "chat/composer-surface.css"), "utf8");
  const start = css.indexOf("@container chat-conversation (height <= 520px)");

  it("keeps the caret slot and the attachment marker in a <=520px conversation", () => {
    expect(start).toBeGreaterThan(-1);
    expect(css.indexOf(CARET, start)).toBeGreaterThan(start);
    expect(css.indexOf(MARKER, start)).toBeGreaterThan(start);
    expect(css.indexOf("min-height: min-content")).toBeGreaterThan(-1);
    expect(css.indexOf("min-height: min-content")).toBeLessThan(start);
  });

  it("reserves a transcript and scrolls every composer, not only an attachment", () => {
    const block = css.slice(start);
    expect(block).toContain("clamp(56px, 28cqh, 120px)");
    expect(block).toContain("height: var(--chat-footer-max-height)");
    expect(block).toContain("field-sizing: fixed !important");
    expect(block).toContain(
      ".chat-main__conversation > .chat-footer .agent-chat__composer-combobox > textarea",
    );
    expect(block).toMatch(/\.chat-attachment-thumb\s*\{\s*width: 36px;\s*height: 36px;/);
    expect(block).not.toMatch(/22dvh/);
  });
});
