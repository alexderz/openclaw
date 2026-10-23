import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart, PartType, type PartInfo } from "lit/directive.js";

/**
 * Chat file links are only links when they open.
 *
 * The Markdown parser marks every path-shaped span as a file link. In the transcript, a
 * link stays a link only when the session's file list already names it, or when one
 * batched `sessions.files.stat` request reports that `sessions.files.get` would find it.
 * Everything else becomes a plain `<span>` holding what was written (text, or its code
 * chip), so it styles, selects and long-presses like ordinary message text.
 * Results are cached per connection, session, message and path: a re-render never asks
 * again, while a later message citing the same path is checked again.
 */
export type ChatFileLinkResolver = {
  /** Session of links outside any `[data-file-session-key]` owner. */
  sessionKey: string;
  /** Connection identity; with `epoch`, no result outlives the connection that produced it. */
  connection: object;
  epoch: number;
  /** Paths the Files panel already loaded for `sessionKey`, or null before a listing exists. */
  knownPaths: (sessionKey: string) => ReadonlySet<string> | null;
  /**
   * One batched existence check. Absent only when the Gateway is known not to offer
   * `sessions.files.stat`; unknown paths then keep their parser links ("unchecked").
   */
  statPaths?: (
    sessionKey: string,
    paths: readonly string[],
  ) => Promise<ReadonlyMap<string, boolean> | null>;
};

/** `unchecked` looks like `open` but is re-evaluated once a check becomes possible. */
export type ChatFileLinkState = "open" | "unchecked" | "pending" | "plain";

const LINK_SELECTOR = "a.markdown-file-link[data-file-path]:not([href]), span[data-file-ref-path]";
const STAT_BATCH_MAX = 64;
const CACHE_MAX_ENTRIES = 4_096;
const FLUSH_DELAY_MS = 32;

/** `failed` keeps a message's paths unlinked for this connection without claiming they are missing. */
type CacheValue = boolean | "pending" | "failed";
type ConnectionCache = { epoch: number; entries: Map<string, CacheValue> };
const caches = new WeakMap<object, ConnectionCache>();
const liveResolutions = new Set<ChatFileLinkResolution>();

function cacheFor(resolver: ChatFileLinkResolver): Map<string, CacheValue> {
  let cache = caches.get(resolver.connection);
  if (!cache || cache.epoch !== resolver.epoch) {
    cache = { epoch: resolver.epoch, entries: new Map() };
    caches.set(resolver.connection, cache);
  }
  return cache.entries;
}

function trimCache(entries: Map<string, CacheValue>): void {
  if (entries.size <= CACHE_MAX_ENTRIES) {
    return;
  }
  // Oldest settled results go first; in-flight entries must survive until they settle.
  for (const [key, value] of entries) {
    if (entries.size <= CACHE_MAX_ENTRIES / 2) {
      break;
    }
    if (value !== "pending") {
      entries.delete(key);
    }
  }
}

function cacheKey(sessionKey: string, messageId: string, path: string): string {
  return `${sessionKey}\0${messageId}\0${path}`;
}

/** Normalizes a cited path the way the Files panel lists it; absolute paths keep their root. */
export function normalizeChatFileLinkPath(path: string): string {
  let value = path.trim().replaceAll("\\", "/");
  while (value.startsWith("./")) {
    value = value.slice(2);
  }
  return value;
}

/** Builds the lookup set from a session file listing (touched files and browser rows). */
export function chatFileLinkKnownPaths(list: {
  root?: string;
  files?: readonly { path: string; workspacePath?: string; missing?: boolean }[];
  browser?: { entries?: readonly { path: string; kind?: string }[] };
}): Set<string> {
  const known = new Set<string>();
  const root = list.root?.replaceAll("\\", "/").replace(/\/+$/u, "");
  const add = (path: string | undefined) => {
    if (!path) {
      return;
    }
    const normalized = normalizeChatFileLinkPath(path);
    known.add(normalized);
    if (root && !normalized.startsWith("/") && !/^[A-Za-z]:\//u.test(normalized)) {
      known.add(`${root}/${normalized}`);
    }
  };
  for (const file of list.files ?? []) {
    if (file.missing) {
      continue;
    }
    add(file.path);
    add(file.workspacePath);
  }
  for (const entry of list.browser?.entries ?? []) {
    if (entry.kind === "file") {
      add(entry.path);
    }
  }
  return known;
}

function linkPath(element: HTMLElement): string | undefined {
  return element.dataset.filePath ?? element.dataset.fileRefPath;
}

function labelNode(element: HTMLElement): Text | null {
  const host = element.querySelector("code") ?? element;
  const node = host.firstChild;
  return node instanceof Text ? node : null;
}

const TO_REF_ATTRIBUTES: Readonly<Record<string, string>> = {
  "data-file-path": "data-file-ref-path",
  "data-file-line": "data-file-ref-line",
};
const TO_LINK_ATTRIBUTES: Readonly<Record<string, string>> = {
  "data-file-ref-path": "data-file-path",
  "data-file-ref-line": "data-file-line",
};
const LINK_ONLY_ATTRIBUTES = new Set(["role", "tabindex", "aria-haspopup", "title", "class"]);

/** Swaps the element for a new tag, carrying children and the attributes that survive. */
function retag(element: HTMLElement, tag: "a" | "span"): HTMLElement {
  const renames = tag === "a" ? TO_LINK_ATTRIBUTES : TO_REF_ATTRIBUTES;
  const next = document.createElement(tag);
  for (const { name, value } of element.attributes) {
    const renamed = renames[name];
    if (renamed) {
      next.setAttribute(renamed, value);
    } else if (!LINK_ONLY_ATTRIBUTES.has(name)) {
      next.setAttribute(name, value);
    }
  }
  next.append(...element.childNodes);
  element.replaceWith(next);
  return next;
}

/** Restores an openable file link: link class, menu button semantics, shortened label. */
function promote(element: HTMLElement): HTMLElement {
  const link = element.tagName === "A" ? element : retag(element, "a");
  link.className = "markdown-file-link";
  link.setAttribute("role", "button");
  link.setAttribute("tabindex", "0");
  link.setAttribute("aria-haspopup", "menu");
  const label = link.dataset.fileLinkLabel;
  const node = labelNode(link);
  if (label !== undefined && node) {
    node.data = label;
  }
  delete link.dataset.fileLinkLabel;
  if (link.dataset.fileLinkTitle !== undefined) {
    link.title = link.dataset.fileLinkTitle;
    delete link.dataset.fileLinkTitle;
  }
  return link;
}

/**
 * Renders a file link as what was written: a span (so code keeps its code chip and text
 * keeps the message color), the full reference instead of the shortened label, and no
 * `data-file-path`, so every file-link click and keyboard path ignores it.
 */
function demote(element: HTMLElement): HTMLElement {
  const reference = element.getAttribute("title");
  const node = labelNode(element);
  // Only parser-shortened labels (a trailing part of the reference) are swapped back;
  // an authored Markdown label stays as written.
  if (
    reference !== null &&
    node &&
    element.dataset.fileLinkLabel === undefined &&
    reference.endsWith(node.data)
  ) {
    element.dataset.fileLinkLabel = node.data;
    node.data = reference;
  }
  if (reference !== null) {
    element.dataset.fileLinkTitle = reference;
  }
  const span = element.tagName === "SPAN" ? element : retag(element, "span");
  span.className = "markdown-file-ref";
  return span;
}

function setState(element: HTMLElement, state: ChatFileLinkState): void {
  if (element.dataset.fileLinkState === state) {
    return;
  }
  const next = state === "open" || state === "unchecked" ? promote(element) : demote(element);
  next.dataset.fileLinkState = state;
}

export class ChatFileLinkResolution {
  private readonly queued = new Map<string, Map<string, Set<string>>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private observer: MutationObserver | undefined;
  private root: HTMLElement | undefined;
  private resolver: ChatFileLinkResolver | undefined;

  attach(root: HTMLElement, resolver: ChatFileLinkResolver | undefined): void {
    this.resolver = resolver;
    if (root !== this.root) {
      this.detach();
      this.root = root;
    }
    liveResolutions.add(this);
    if (!this.observer && typeof MutationObserver === "function") {
      // Mutation callbacks run before paint, so a new row never flashes an unopenable link.
      this.observer = new MutationObserver(() => this.scan(false));
      this.observer.observe(root, { childList: true, subtree: true });
    }
    // Lit commits this element before its rows; resolve after the synchronous commit.
    queueMicrotask(() => this.scan(true));
  }

  detach(): void {
    liveResolutions.delete(this);
    this.observer?.disconnect();
    this.observer = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queued.clear();
    this.root = undefined;
  }

  /** Classifies links; `all` revisits unsettled links after the listing or cache changed. */
  scan(all: boolean): void {
    const root = this.root;
    const resolver = this.resolver;
    // Without a resolver (no connection yet, or method support still unknown) nothing changes.
    if (!root?.isConnected || !resolver) {
      return;
    }
    const cache = cacheFor(resolver);
    const knownBySession = new Map<string, ReadonlySet<string> | null>();
    for (const element of root.querySelectorAll<HTMLElement>(LINK_SELECTOR)) {
      const current = element.dataset.fileLinkState;
      if (current === "open" || (!all && current !== undefined)) {
        continue;
      }
      const path = linkPath(element);
      if (!path) {
        continue;
      }
      const sessionKey =
        element.closest<HTMLElement>("[data-file-session-key]")?.dataset.fileSessionKey ??
        resolver.sessionKey;
      let known = knownBySession.get(sessionKey);
      if (known === undefined) {
        known = resolver.knownPaths(sessionKey);
        knownBySession.set(sessionKey, known);
      }
      if (known?.has(normalizeChatFileLinkPath(path))) {
        setState(element, "open");
        continue;
      }
      const bubble = element.closest<HTMLElement>(".chat-bubble");
      const key = cacheKey(sessionKey, bubble?.dataset.messageId ?? "", path);
      const cached = cache.get(key);
      if (cached === true) {
        setState(element, "open");
        continue;
      }
      if (cached === false || cached === "failed") {
        setState(element, "plain");
        continue;
      }
      if (!resolver.statPaths) {
        setState(element, "unchecked");
        continue;
      }
      setState(element, "pending");
      // A streaming reply keeps changing; check its paths once it settles.
      if (cached === undefined && !bubble?.classList.contains("streaming")) {
        let paths = this.queued.get(sessionKey);
        if (!paths) {
          paths = new Map();
          this.queued.set(sessionKey, paths);
        }
        let keys = paths.get(path);
        if (!keys) {
          keys = new Set();
          paths.set(path, keys);
        }
        keys.add(key);
      }
    }
    if (this.queued.size > 0 && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, FLUSH_DELAY_MS);
    }
  }

  private flush(): void {
    const resolver = this.resolver;
    const statPaths = resolver?.statPaths;
    const batches = [...this.queued];
    this.queued.clear();
    if (!resolver || !statPaths) {
      return;
    }
    const cache = cacheFor(resolver);
    trimCache(cache);
    for (const [sessionKey, queuedPaths] of batches) {
      const pending = [...queuedPaths]
        .map(([path, keys]) => [path, [...keys].filter((key) => !cache.has(key))] as const)
        .filter(([, keys]) => keys.length > 0);
      // One request covers every newly rendered message of a session; never one per path.
      for (let start = 0; start < pending.length; start += STAT_BATCH_MAX) {
        const batch = pending.slice(start, start + STAT_BATCH_MAX);
        for (const [, keys] of batch) {
          for (const key of keys) {
            cache.set(key, "pending");
          }
        }
        void statPaths(
          sessionKey,
          batch.map(([path]) => path),
        )
          .catch(() => null)
          .then((result) => {
            for (const [path, keys] of batch) {
              for (const key of keys) {
                if (cache.get(key) === "pending") {
                  cache.set(key, result ? result.get(path) === true : "failed");
                }
              }
            }
            // Split panes share the cache; every live transcript picks up the answer.
            for (const resolution of liveResolutions) {
              resolution.scan(true);
            }
          });
      }
    }
  }
}

class ChatFileLinkResolutionDirective extends AsyncDirective {
  private readonly resolution = new ChatFileLinkResolution();
  private element: HTMLElement | undefined;
  private resolver: ChatFileLinkResolver | undefined;

  constructor(partInfo: PartInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.ELEMENT) {
      throw new Error("chatFileLinkResolution must be used as an element directive");
    }
  }

  render(_resolver: ChatFileLinkResolver | undefined) {
    return nothing;
  }

  override update(part: ElementPart, [resolver]: [ChatFileLinkResolver | undefined]) {
    if (part.element instanceof HTMLElement) {
      this.element = part.element;
      this.resolver = resolver;
      this.resolution.attach(part.element, resolver);
    }
    return nothing;
  }

  protected override disconnected(): void {
    this.resolution.detach();
  }

  protected override reconnected(): void {
    if (this.element) {
      this.resolution.attach(this.element, this.resolver);
    }
  }
}

export const chatFileLinkResolution = directive(ChatFileLinkResolutionDirective);
