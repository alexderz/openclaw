// Headless reproduction of the phone composer caret falling below a keyboard-sized
// pane. This is a layout simulation, not a physical phone or IME.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = join(root, "ui/src/styles/chat/composer-surface.css");
const thumbCss = join(root, "ui/src/styles/chat/composer.css");
const out = "/tmp/composer-caret-visible.html";
const text =
  "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november";

const html = `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="${css}">
<link rel="stylesheet" href="${thumbCss}">
<style>
  :root { --bg:#111; --text:#eee; --text-strong:#fff; --muted:#aaa; --popover:#222; --card:#222; --border:#444; --primary:#48f; --primary-foreground:#fff; --chat-thread-gutter:0px; --chat-mobile-edge-inset:0px; --chat-composer-side-inset:0px; --chat-thread-max-width:48rem; --control-ui-text-scale:1; --control-ui-text-md:13px; --radius-sm:6px; --radius-full:999px; --duration-fast:0ms; --openclaw-corner-radius-scale:1; }
  body { margin:0; }
  html, body, .shell { height:100%; }
  .shell { height:100dvh; display:flex; }
  .chat-main__conversation { --chat-composer-top-margin:8px; --chat-footer-max-height:calc(100cqh - clamp(60px, 20cqh, 160px)); container:chat-conversation / size; display:flex; flex-direction:column; width:100%; height:100%; overflow:hidden; }
  .chat-thread { flex:1 1 auto; min-height:0; overflow:auto; }
  .chat-footer { position:relative; display:flex; flex:0 1 auto; flex-direction:column; min-width:0; min-height:0; max-height:var(--chat-footer-max-height); }
  .agent-chat__composer-footer { min-height:36px; }
</style>
<div class="shell"><div class="chat-main__conversation">
  <div class="chat-thread"><div style="height:800px">transcript</div></div>
  <footer class="chat-footer"><div class="agent-chat__composer-shell"><div class="agent-chat__input agent-chat__input--mobile-toolbar">
    <div class="agent-chat__composer-lede"><div class="chat-attachments-preview"><div class="chat-attachment-thumb"></div></div></div>
    <div class="agent-chat__composer-input-row"><div class="agent-chat__composer-combobox"><textarea rows="1"></textarea></div></div>
    <div class="agent-chat__composer-footer">actions</div>
  </div></div></footer>
</div></div>
<pre id="out"></pre>
<script>
const ta = document.querySelector("textarea");
const thread = document.querySelector(".chat-thread");
thread.scrollTop = 40;
ta.value = ${JSON.stringify(text)};
ta.selectionStart = ta.selectionEnd = ta.value.length;
const style = getComputedStyle(ta);
const mirror = document.createElement("div");
mirror.style.cssText = "position:absolute;left:-9999px;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;width:" + ta.clientWidth + "px;font:" + style.font + ";line-height:" + style.lineHeight + ";padding:" + style.paddingTop + " " + style.paddingRight + " " + style.paddingBottom + " " + style.paddingLeft;
mirror.textContent = ta.value;
document.body.appendChild(mirror);
const line = parseFloat(style.lineHeight) || 24;
const caretBottom = mirror.scrollHeight - parseFloat(style.paddingBottom);
const client = ta.clientHeight;
const maxScroll = Math.max(0, ta.scrollHeight - client);
const needed = Math.ceil(caretBottom - client);
if (needed > ta.scrollTop + 1) ta.scrollTop = Math.max(0, Math.min(maxScroll, needed));
const rect = ta.getBoundingClientRect();
const conv = document.querySelector(".chat-main__conversation").getBoundingClientRect();
const visibleBottom = Math.min(rect.bottom, conv.bottom);
const caretViewport = rect.top + caretBottom - ta.scrollTop;
document.getElementById("out").textContent = JSON.stringify({
  caretInside: caretViewport - line >= Math.max(rect.top, conv.top) - 1 && caretViewport <= visibleBottom + 1,
  past: rect.bottom > conv.bottom + 1,
  scrollTop: ta.scrollTop,
  thread: thread.scrollTop,
  threadH: Math.round(document.querySelector(".chat-thread").getBoundingClientRect().height),
  taH: Math.round(rect.height)
});
</script>`;

writeFileSync(out, html);
const heights = [260, 300, 390, 700];
const failures = [];
for (const height of heights) {
  const run = spawnSync(
    "chromium-browser",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--allow-file-access-from-files",
      `--window-size=420,${height}`,
      "--virtual-time-budget=1500",
      "--dump-dom",
      `file://${out}`,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) {
    failures.push(`${height}: chromium exit ${run.status}`);
    continue;
  }
  const match = run.stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (!match) {
    failures.push(`${height}: no measurement`);
    continue;
  }
  const data = JSON.parse(match[1]);
  const ok = data.caretInside && !data.past && data.thread === 40 && data.threadH >= 48;
  console.log(`${height} ${ok ? "ok" : "FAIL"} ${JSON.stringify(data)}`);
  if (!ok) failures.push(`${height}: ${JSON.stringify(data)}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("composer caret visible in simulated keyboard panes");
