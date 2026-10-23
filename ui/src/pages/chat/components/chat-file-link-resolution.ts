import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart, PartType, type PartInfo } from "lit/directive.js";

/**
 * Chat file links are only links when they open.
 *
 * The Markdown parser marks every path-shaped span as a file link. In the transcript, a
 * link stays a link only when the session's file list already names it, or when one
 * batched `sessions.files.stat` request reports that `sessions.files.get` would find it.
 * Everything else renders as the text (or code) it was written as. Results are cached per
 * connection, session and path, so re-renders never ask twice.
 */
export type ChatFileLinkResolver = {
  /** Session of links outside any `[data-file-session-key]` owner. */
  sessionKey: string;
  /** Paths the Files panel already loaded for `sessionKey`, or null before a listing exists. */
  knownPaths: (sessionKey: string) => ReadonlySet<string> | null;
  /**
   * One batched existence check. Absent when the Gateway predates `sessions.files.stat`;
   * unknown paths then keep their parser links rather than all turning into text.
   */
  statPaths?: (
    sessionKey: string,
    paths: readonly string[],
  ) => Promise<ReadonlyMap<string, boolean> | null>;
  /** Cache lifetime owner, normally the Gateway client: a reconnect starts a fresh cache. */
  cacheOwner: object;
};

export type ChatFileLinkState = "open" | "pending" | "plain";

const LINK_SELECTOR = "a[data-file-path], a[data-file-ref-path]";
const STAT_BATCH_MAX = 64;
const CACHE_MAX_ENTRIES = 4_096;
const FLUSH_DELAY_MS = 32;

type CacheValue = boolean | "pending";
const caches = new WeakMap<object, Map<string, CacheValue>>();

function cacheFor(owner: object): Map<string, CacheValue> {
  let cache = caches.get(owner);
  if (!cache) {
    cache = new Map();
    caches.set(owner, cache);
  }
  return cache;
}

function cacheKey(sessionKey: string, path: string): string {
  return `${sessionKey}\0${path}`;
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

function linkPath(anchor: HTMLElement): string | undefined {
  return anchor.dataset.filePath ?? anchor.dataset.fileRefPath;
}

function labelNode(anchor: HTMLElement): Text | null {
  const host = anchor.querySelector("code") ?? anchor;
  const node = host.firstChild;
  return node instanceof Text ? node : null;
}

/** Restores an open file link: link class, button semantics and the shortened label. */
function promote(anchor: HTMLAnchorElement): void {
  const path = anchor.dataset.fileRefPath;
  if (path !== undefined) {
    anchor.dataset.filePath = path;
    delete anchor.dataset.fileRefPath;
  }
  if (anchor.dataset.fileRefLine !== undefined) {
    anchor.dataset.fileLine = anchor.dataset.fileRefLine;
    delete anchor.dataset.fileRefLine;
  }
  anchor.classList.replace("markdown-file-ref", "markdown-file-link");
  anchor.setAttribute("role", "button");
  anchor.setAttribute("tabindex", "0");
  const label = anchor.dataset.fileLinkLabel;
  const node = labelNode(anchor);
  if (label !== undefined && node) {
    node.data = label;
  }
  delete anchor.dataset.fileLinkLabel;
  if (anchor.dataset.fileLinkTitle !== undefined) {
    anchor.title = anchor.dataset.fileLinkTitle;
    delete anchor.dataset.fileLinkTitle;
  }
}

/**
 * Renders a file link as what was written: no link class (so code keeps its code chip),
 * no button role, the full reference instead of the shortened label, and no
 * `data-file-path`, so every file-link click and keyboard path ignores it.
 */
function demote(anchor: HTMLAnchorElement): void {
  const path = anchor.dataset.filePath;
  if (path !== undefined) {
    anchor.dataset.fileRefPath = path;
    delete anchor.dataset.filePath;
  }
  if (anchor.dataset.fileLine !== undefined) {
    anchor.dataset.fileRefLine = anchor.dataset.fileLine;
    delete anchor.dataset.fileLine;
  }
  anchor.classList.replace("markdown-file-link", "markdown-file-ref");
  anchor.removeAttribute("role");
  anchor.removeAttribute("tabindex");
  const reference = anchor.getAttribute("title");
  if (reference !== null) {
    const node = labelNode(anchor);
    // Only parser-shortened labels (a trailing part of the reference) are swapped back;
    // an authored Markdown label stays as written.
    if (node && anchor.dataset.fileLinkLabel === undefined && reference.endsWith(node.data)) {
      anchor.dataset.fileLinkLabel = node.data;
      node.data = reference;
    }
    anchor.dataset.fileLinkTitle = reference;
    anchor.removeAttribute("title");
  }
}

function setState(anchor: HTMLAnchorElement, state: ChatFileLinkState): void {
  if (anchor.dataset.fileLinkState === state) {
    return;
  }
  if (state === "open") {
    promote(anchor);
  } else {
    demote(anchor);
  }
  anchor.dataset.fileLinkState = state;
}

export class ChatFileLinkResolution {
  private readonly queued = new Map<string, Set<string>>();
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
    if (!this.observer && typeof MutationObserver === "function") {
      // Mutation callbacks run before paint, so a new row never flashes an unopenable link.
      this.observer = new MutationObserver(() => this.scan(false));
      this.observer.observe(root, { childList: true, subtree: true });
    }
    // Lit commits this element before its rows; resolve after the synchronous commit.
    queueMicrotask(() => this.scan(true));
  }

  detach(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queued.clear();
    this.root = undefined;
  }

  /** Classifies links; `all` revisits settled links after the listing or cache changed. */
  scan(all: boolean): void {
    const root = this.root;
    if (!root?.isConnected) {
      return;
    }
    const resolver = this.resolver;
    // Surfaces without a resolver keep the parser's links unchanged.
    if (!resolver) {
      return;
    }
    const cache = cacheFor(resolver.cacheOwner);
    const knownBySession = new Map<string, ReadonlySet<string> | null>();
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>(LINK_SELECTOR)) {
      const current = anchor.dataset.fileLinkState;
      if (!all && current !== undefined) {
        continue;
      }
      if (current === "open") {
        continue;
      }
      const path = linkPath(anchor);
      if (!path) {
        setState(anchor, "plain");
        continue;
      }
      const sessionKey =
        anchor.closest<HTMLElement>("[data-file-session-key]")?.dataset.fileSessionKey ??
        resolver.sessionKey;
      let known = knownBySession.get(sessionKey);
      if (known === undefined) {
        known = resolver.knownPaths(sessionKey);
        knownBySession.set(sessionKey, known);
      }
      if (known?.has(normalizeChatFileLinkPath(path))) {
        setState(anchor, "open");
        continue;
      }
      const cached = cache.get(cacheKey(sessionKey, path));
      if (cached === true) {
        setState(anchor, "open");
        continue;
      }
      if (!resolver.statPaths) {
        setState(anchor, "open");
        continue;
      }
      if (cached === false) {
        setState(anchor, "plain");
        continue;
      }
      setState(anchor, "pending");
      // A streaming reply keeps changing; check its paths once it settles.
      if (cached === undefined && !anchor.closest(".chat-bubble.streaming")) {
        let paths = this.queued.get(sessionKey);
        if (!paths) {
          paths = new Set();
          this.queued.set(sessionKey, paths);
        }
        paths.add(path);
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
    const cache = cacheFor(resolver.cacheOwner);
    if (cache.size > CACHE_MAX_ENTRIES) {
      cache.clear();
    }
    for (const [sessionKey, queuedPaths] of batches) {
      const paths = [...queuedPaths].filter((path) => !cache.has(cacheKey(sessionKey, path)));
      // One request covers every newly rendered message of a session; never one per path.
      for (let start = 0; start < paths.length; start += STAT_BATCH_MAX) {
        const batch = paths.slice(start, start + STAT_BATCH_MAX);
        for (const path of batch) {
          cache.set(cacheKey(sessionKey, path), "pending");
        }
        void statPaths(sessionKey, batch)
          .catch(() => null)
          .then((result) => {
            for (const path of batch) {
              const key = cacheKey(sessionKey, path);
              if (cache.get(key) === "pending") {
                // Failures stay plain until the next connection, not until the next render.
                cache.set(key, result?.get(path) === true);
              }
            }
            this.scan(true);
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
