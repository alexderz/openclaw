// The phone fix for "attached image with the keyboard open" lives in source CSS so the
// build carries it; losing it once left the draft invisible (DER-6xx).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const MARKER = "--openclaw-composer-attachment-visible";

describe("composer attachment visibility", () => {
  const css = fs.readFileSync(path.join(stylesDir, "chat/composer-surface.css"), "utf8");
  const start = css.indexOf("@container chat-conversation (height <= 520px)");

  it("keeps the marker rule in a <=520px conversation container", () => {
    expect(start).toBeGreaterThan(-1);
    expect(css.indexOf(MARKER, start)).toBeGreaterThan(start);
    expect(css.indexOf("min-height: min-content")).toBeGreaterThan(-1);
    expect(css.indexOf("min-height: min-content")).toBeLessThan(start);
  });

  it("clamps the footer and makes the draft the scrollport when an attachment is present", () => {
    const block = css.slice(start);
    expect(block).toContain("clamp(56px, 28cqh, 120px)");
    expect(block).toMatch(/\.chat-attachment-thumb\s*\{\s*width: 36px;\s*height: 36px;/);
    expect(block).toContain("flex-shrink: 0");
    expect(block).toContain("height: var(--chat-footer-max-height)");
    expect(block).toContain("field-sizing: fixed !important");
    expect(block).toContain("max-height: 100% !important");
    expect(block).toContain(".chat-footer:has(.chat-attachments-preview)");
  });
});
