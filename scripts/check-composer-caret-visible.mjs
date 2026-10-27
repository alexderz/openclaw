// Headless layout simulation of the composer caret. Not a phone, not an IME, not live 109.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = join(
  root,
  "../molting-109-combined/node_modules/esbuild/bin/esbuild",
);
const bundleDir = mkdtempSync(join(tmpdir(), "composer-caret-"));
const bundle = join(bundleDir, "caret.js");
const built = spawnSync(
  esbuild,
  [
    join(root, "ui/src/pages/chat/components/composer-caret.ts"),
    "--bundle",
    "--format=iife",
    "--global-name=Caret",
    `--outfile=${bundle}`,
  ],
  { encoding: "utf8" },
);
if (built.status !== 0) {
  console.error(built.stderr || built.stdout);
  process.exit(1);
}

const htmlPath = join(bundleDir, "index.html");
const startup = join(root, "ui/src/styles/chat/startup-layout.css");
const surface = join(root, "ui/src/styles/chat/composer-surface.css");
const composer = join(root, "ui/src/styles/chat/composer.css");
const html = `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="${startup}">
<link rel="stylesheet" href="${surface}">
<link rel="stylesheet" href="${composer}">
<style>
  :root {
    --bg:#111; --text:#eee; --text-strong:#fff; --muted:#aaa; --popover:#222; --card:#222;
    --border:#444; --primary:#48f; --primary-foreground:#fff; --chat-thread-gutter:0px;
    --chat-mobile-edge-inset:0px; --chat-composer-side-inset:0px; --chat-thread-max-width:48rem;
    --control-ui-text-scale:1; --control-ui-text-md:13px; --radius-sm:6px; --radius-full:999px;
    --duration-fast:0ms; --openclaw-corner-radius-scale:1; --chat-transcript-fade-height:0px;
  }
  html, body { margin:0; }
  .chat-main__conversation-frame { height: var(--fixture-height, 180px); }
  .agent-chat__composer-footer { min-height:36px; }
  /* Installed grow unlock. The source slot must beat this. */
  @container chat-conversation (height <= 320px) {
    .agent-chat__composer-combobox > :is(textarea, input) {
      max-height: min(25dvh, calc(var(--chat-composer-editor-line) * 6 + var(--chat-composer-editor-inset-block) * 2)) !important;
    }
  }
</style>
<div class="chat"><div class="chat-main__conversation-frame"><div class="chat-main__conversation">
  <div class="chat-thread"><div style="height:2400px">transcript</div></div>
  <footer class="chat-footer"><div class="agent-chat__composer-shell"><div class="agent-chat__input">
    <div class="agent-chat__composer-lede" id="lede"></div>
    <div class="agent-chat__composer-input-row"><div class="agent-chat__composer-combobox"><textarea rows="1"></textarea></div></div>
    <div class="agent-chat__composer-footer">actions</div>
  </div></div></footer>
</div></div></div>
<script src="${bundle}"></script>
<pre id="out"></pre>
<script>
const [mode, heightPx] = (location.hash || "#plain-180").slice(1).split("-");
document.documentElement.style.setProperty("--fixture-height", heightPx + "px");
if (mode === "attachment") {
  document.getElementById("lede").innerHTML = '<div class="chat-attachments-preview"><div class="chat-attachment-thumb"></div></div>';
}
const ta = document.querySelector("textarea");
const thread = document.querySelector(".chat-thread");
const lines = Array.from({ length: 14 }, (_, i) => "wrapped line " + (i + 1) + " xxxxxxx");
const value = lines.join("\\n");
function lineIndex(n) {
  return lines.slice(0, n - 1).join("\\n").length + (n > 1 ? 1 : 0);
}
function markerBox(offset) {
  const style = getComputedStyle(ta);
  const mirror = document.createElement("div");
  mirror.style.cssText = "position:absolute;left:-9999px;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;width:" + ta.clientWidth + "px;font:" + style.font + ";line-height:" + style.lineHeight + ";padding:" + style.paddingTop + " " + style.paddingRight + " " + style.paddingBottom + " " + style.paddingLeft;
  mirror.append(document.createTextNode(ta.value.slice(0, offset)), Object.assign(document.createElement("span"), { textContent: "\\u200b" }));
  document.body.appendChild(mirror);
  const marker = mirror.querySelector("span");
  const top = marker.offsetTop;
  const bottom = top + (marker.offsetHeight || parseFloat(style.lineHeight) || 24);
  mirror.remove();
  return { top, bottom };
}
function inside(offset) {
  const box = markerBox(offset);
  const rect = ta.getBoundingClientRect();
  const viewTop = rect.top + box.top - ta.scrollTop;
  const viewBottom = rect.top + box.bottom - ta.scrollTop;
  return viewTop >= rect.top - 1 && viewBottom <= rect.bottom + 1;
}
function reveal() { Caret.revealComposerCaret(ta); }
const results = [];
function check(name, ok, extra) {
  const box = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height);
  results.push({ name, ok, thread: thread.scrollTop, threadH: Math.round(thread.getBoundingClientRect().height), footerH: box(".chat-footer"), shellH: box(".agent-chat__composer-shell"), inputH: box(".agent-chat__input"), rowH: box(".agent-chat__composer-input-row"), ...extra });
}
thread.scrollTop = 40;
ta.value = value;
ta.setSelectionRange(value.length, value.length, "forward");
ta.scrollTop = 0;
reveal();
check("end-scrolls", ta.scrollTop > 20 && inside(value.length) && thread.scrollTop === 40 && thread.getBoundingClientRect().height >= 48, { scrollTop: ta.scrollTop, taH: Math.round(ta.getBoundingClientRect().height) });

const mid = lineIndex(7);
ta.scrollTop = ta.scrollHeight;
const endScroll = ta.scrollTop;
const midVisibleAtEnd = inside(mid);
ta.setSelectionRange(mid, mid, "none");
const midBefore = [ta.selectionStart, ta.selectionEnd];
reveal();
check(
  "collapsed-middle",
  inside(mid) &&
    ta.selectionStart === midBefore[0] &&
    ta.selectionEnd === midBefore[1] &&
    (midVisibleAtEnd || ta.scrollTop < endScroll),
  { scrollTop: ta.scrollTop, endScroll, midVisibleAtEnd },
);

const backStart = lineIndex(2);
const backEnd = lineIndex(12);
ta.scrollTop = ta.scrollHeight;
ta.setSelectionRange(backStart, backEnd, "backward");
reveal();
check("backward-active-end", ta.selectionDirection === "backward" && ta.selectionStart === backStart && ta.selectionEnd === backEnd && inside(backStart) && !inside(backEnd), { scrollTop: ta.scrollTop });

ta.scrollTop = 0;
ta.setSelectionRange(backStart, backEnd, "forward");
reveal();
check("forward-active-end", ta.selectionDirection === "forward" && ta.selectionStart === backStart && ta.selectionEnd === backEnd && inside(backEnd), { scrollTop: ta.scrollTop });

ta.value = value + "\\n";
ta.setSelectionRange(ta.value.length, ta.value.length, "none");
ta.scrollTop = 0;
reveal();
check("trailing-newline", inside(ta.value.length) && thread.scrollTop === 40, { scrollTop: ta.scrollTop });

thread.scrollTop = 40;
Caret.captureComposerScrollHold(ta);
thread.scrollTop = 400;
Caret.revealComposerCaret(ta);
Caret.restoreComposerScrollHold(ta);
check("restore-hold-from-before", thread.scrollTop === 40, {});

Caret.revealComposerCaretForEdit(ta);
const pinned = ta.scrollTop;
ta.focus();
const viewport = new AbortController();
Caret.installComposerCaretViewport(ta, viewport.signal);
ta.scrollTop = 0;
Caret.noteComposerDraftReading(ta);
Caret.rememberComposerCaret(ta);
const heldScroll = ta.scrollTop;
document.dispatchEvent(new Event("selectionchange"));
Caret.revealComposerCaretForCaretMove(ta);
const afterSelection = ta.scrollTop;
window.visualViewport.dispatchEvent(new Event("scroll"));
const afterViewportScroll = ta.scrollTop;
window.visualViewport.dispatchEvent(new Event("resize"));
const afterReadingResize = ta.scrollTop;
check(
  "manual-scroll-stays",
  heldScroll === 0 && afterSelection === 0 && afterViewportScroll === 0 && afterReadingResize === 0 && pinned > 20,
  {
    pinned,
    afterSelection,
    afterViewportScroll,
    afterReadingResize,
    viewportOffsetTop: window.visualViewport.offsetTop,
    nonzeroViewportOffset: window.visualViewport.offsetTop === 0 ? "not simulated; headless offset stays 0" : "simulated",
  },
);
ta.setSelectionRange(0, 0, "none");
Caret.revealComposerCaretForCaretMove(ta);
check("caret-move-after-manual-scroll", ta.scrollTop < 5 && inside(0), { scrollTop: ta.scrollTop });
ta.setSelectionRange(value.length, value.length, "forward");
Caret.revealComposerCaretForEdit(ta);
check("typing-after-manual-scroll", ta.scrollTop > 20 && inside(value.length), { scrollTop: ta.scrollTop });
viewport.abort();
const cleanup = new AbortController();
ta.scrollTop = 0;
Caret.installComposerCaretViewport(ta, cleanup.signal);
window.visualViewport.dispatchEvent(new Event("resize"));
const afterResize = ta.scrollTop;
cleanup.abort();
ta.scrollTop = 0;
window.visualViewport.dispatchEvent(new Event("resize"));
check("viewport-resize-cleans-up", afterResize > 20 && ta.scrollTop === 0, { afterResize, afterAbort: ta.scrollTop });
document.getElementById("out").textContent = JSON.stringify(results);
</script>`;
writeFileSync(htmlPath, html);

const failures = [];
for (const height of [180, 320, 390]) {
  for (const mode of ["plain", "attachment"]) {
    const run = spawnSync(
      "chromium-browser",
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--allow-file-access-from-files",
        "--window-size=420,800",
        "--virtual-time-budget=2000",
        "--dump-dom",
        `file://${htmlPath}#${mode}-${height}`,
      ],
      { encoding: "utf8" },
    );
    if (run.status !== 0) {
      failures.push(`${mode}@${height}: exit ${run.status}`);
      continue;
    }
    const match = run.stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!match) {
      failures.push(`${mode}@${height}: no result`);
      continue;
    }
    const rows = JSON.parse(match[1]);
    for (const row of rows) {
      const label = `${mode}@${height} ${row.name}`;
      console.log(`${row.ok ? "ok" : "FAIL"} ${label} ${JSON.stringify(row)}`);
      if (!row.ok) failures.push(label);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("composer caret visible for plain and attachment");
