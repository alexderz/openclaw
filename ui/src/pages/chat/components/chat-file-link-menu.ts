import { handleCopyButton } from "../../../components/copy-button.ts";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import { t } from "../../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { claimReplyContextMenu, type ChatThreadProps } from "./chat-thread-interactions.ts";

const GAP_PX = 4;
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
  menu.append(path, open, copy);
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
  (anchor.closest("openclaw-modal-dialog, dialog") ?? document.body).appendChild(menu);

  const anchorRect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = anchorRect.left;
  let top = anchorRect.bottom + GAP_PX;
  if (left + menuRect.width > window.innerWidth) {
    left = window.innerWidth - menuRect.width - 8;
  }
  if (top + menuRect.height > window.innerHeight) {
    top = anchorRect.top - menuRect.height - GAP_PX;
  }
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;
  open.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    if (!owner.isCurrent()) {
      return;
    }
    const dismissOutside = (event: Event) => {
      if (!menu.contains(event.target as Node | null)) {
        owner.release();
      }
    };
    const { signal } = owner;
    document.addEventListener("click", dismissOutside, { signal });
    document.addEventListener("contextmenu", dismissOutside, { capture: true, signal });
    // A fixed menu must not float away from its link while the transcript scrolls.
    document.addEventListener("scroll", dismissOutside, { capture: true, signal });
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
