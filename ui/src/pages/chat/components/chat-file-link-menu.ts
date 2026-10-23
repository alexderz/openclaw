import { handleCopyButton } from "../../../components/copy-button.ts";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import { t } from "../../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { claimReplyContextMenu, type ChatThreadProps } from "./chat-thread-interactions.ts";

const GAP_PX = 4;
const EDGE_PX = 8;
const COPIED_CLOSE_MS = 700;

function menuItem(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  const text = document.createElement("span");
  text.dataset.copyLabel = "";
  text.textContent = label;
  button.append(text);
  return button;
}

/**
 * Tapping a transcript file link asks first: "Open" or "Copy path". A phone has no hover
 * and its long-press belongs to the browser's selection menu, so this tap menu is the only
 * way to get the exact path onto the clipboard there. The menu is a plain click flow; it
 * never handles contextmenu, so the mobile long-press patch is unaffected.
 */
export function openChatFileLinkMenu(
  anchor: HTMLElement,
  target: MarkdownFileLinkTarget,
  props: Pick<ChatThreadProps, "paneId" | "onOpenWorkspaceFile">,
  opts: { viaKeyboard?: boolean } = {},
): void {
  registerFilePreviewEnglish();
  const menu = document.createElement("div");
  menu.className = "chat-reply-context-menu chat-file-link-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("chat.detailPanel.fileActions"));
  const path = document.createElement("div");
  path.className = "chat-file-link-menu__path";
  path.textContent = target.path;
  const open = menuItem(t("chat.detailPanel.openFile"));
  const copyLabel = t("chat.detailPanel.copyPath");
  const copy = menuItem(copyLabel);
  const items = [open, copy];
  menu.append(path, ...items);
  const owner = claimReplyContextMenu(menu, props.paneId);
  open.addEventListener("click", () => {
    owner.release();
    props.onOpenWorkspaceFile?.(target);
  });
  copy.addEventListener("click", (copyEvent) => {
    // The clipboard write starts inside this tap, which iOS Safari requires.
    void handleCopyButton(copyEvent, target.path, copyLabel).then((copied) => {
      if (copied) {
        setTimeout(owner.release, COPIED_CLOSE_MS);
      }
    });
  });
  menu.addEventListener("keydown", (event) => {
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Tab" ? 0 : null;
    if (step === 0) {
      // Focus returns to the link, so Tab continues from there instead of leaving the page.
      owner.release();
      anchor.focus({ preventScroll: true });
    } else if (step !== null) {
      event.preventDefault();
      items[(index + step + items.length) % items.length]?.focus();
    }
  });
  // The expanded-table modal closes itself on any link click, so its menu lives on the page.
  const layer = anchor.closest(".markdown-table-modal")
    ? null
    : anchor.closest("openclaw-modal-dialog, dialog");
  (layer ?? document.body).appendChild(menu);

  const scroller = anchor.closest<HTMLElement>(".chat-thread");
  /** The menu belongs to a visible link; once it scrolls away or is unmounted, it closes. */
  const linkVisible = (rect: DOMRect) => {
    const bounds = scroller?.getBoundingClientRect();
    const top = Math.max(0, bounds?.top ?? 0);
    const bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight);
    return anchor.isConnected && rect.bottom >= top && rect.top <= bottom;
  };
  const place = () => {
    const rect = anchor.getBoundingClientRect();
    if (!linkVisible(rect)) {
      owner.release();
      return;
    }
    const menuRect = menu.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + GAP_PX;
    if (left + menuRect.width > window.innerWidth) {
      left = window.innerWidth - menuRect.width - EDGE_PX;
    }
    if (top + menuRect.height > window.innerHeight) {
      top = rect.top - menuRect.height - GAP_PX;
    }
    menu.style.left = `${Math.max(0, left)}px`;
    menu.style.top = `${Math.max(0, top)}px`;
  };
  place();
  const focusOpen = () => {
    if (owner.isCurrent()) {
      open.focus({ preventScroll: true });
    }
  };
  // A keyboard-opened menu takes focus after the key is released, so the same press
  // (a held Enter, or Space activating on keyup) cannot choose "Open" by itself. The
  // listener is added now: a quick tap can release the key before the next frame.
  if (opts.viaKeyboard) {
    document.addEventListener("keyup", focusOpen, { once: true, signal: owner.signal });
  }
  requestAnimationFrame(() => {
    if (!owner.isCurrent()) {
      return;
    }
    const { signal } = owner;
    if (!opts.viaKeyboard) {
      focusOpen();
    }
    // pointerdown reaches the document on iOS Safari even where click does not.
    const dismissOutside = (event: Event) => {
      if (!menu.contains(event.target as Node | null)) {
        owner.release();
      }
    };
    document.addEventListener("pointerdown", dismissOutside, { capture: true, signal });
    document.addEventListener("contextmenu", dismissOutside, { capture: true, signal });
    // Streaming output scrolls the transcript; the menu follows its link instead of closing.
    let placing = false;
    document.addEventListener(
      "scroll",
      () => {
        if (!placing) {
          placing = true;
          requestAnimationFrame(() => {
            placing = false;
            place();
          });
        }
      },
      { capture: true, passive: true, signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          owner.release();
          if (anchor.isConnected) {
            anchor.focus({ preventScroll: true });
          }
        }
      },
      { signal },
    );
  });
}
