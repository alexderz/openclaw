/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import {
  chatFileLinkKnownPaths,
  ChatFileLinkResolution,
  type ChatFileLinkResolver,
} from "./chat-file-link-resolution.ts";

const SESSION = "agent:main:main";

type TestMessage = { markdown: string; streaming?: boolean; session?: string; id?: string };

function appendMessages(root: HTMLElement, messages: readonly TestMessage[]) {
  for (const message of messages) {
    const bubble = root.appendChild(document.createElement("div"));
    bubble.className = message.streaming ? "chat-bubble streaming" : "chat-bubble";
    if (message.id) {
      bubble.dataset.messageId = message.id;
    }
    if (message.session) {
      bubble.dataset.fileSessionKey = message.session;
    }
    const text = bubble.appendChild(document.createElement("div"));
    text.className = "chat-text";
    text.innerHTML = toSanitizedMarkdownHtml(message.markdown, { fileLinks: true });
  }
}

function mountMessages(...messages: TestMessage[]) {
  const root = document.body.appendChild(document.createElement("div"));
  root.className = "chat-thread";
  appendMessages(root, messages);
  return root;
}

function fileRefs(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>("a[data-file-path], span[data-file-ref-path]")];
}

function stateOf(root: ParentNode, path: string) {
  const element = fileRefs(root).find(
    (candidate) => (candidate.dataset.filePath ?? candidate.dataset.fileRefPath) === path,
  );
  return element?.dataset.fileLinkState;
}

type TestResolver = ChatFileLinkResolver & { statPaths: ReturnType<typeof vi.fn> };

function resolver(
  overrides: Partial<ChatFileLinkResolver> & { exists?: readonly string[] } = {},
): TestResolver {
  const { exists: existing, ...rest } = overrides;
  const exists = new Set(existing ?? []);
  const statPaths = vi.fn(
    async (_sessionKey: string, paths: readonly string[]) =>
      new Map(paths.map((path) => [path, exists.has(path)])),
  );
  return {
    sessionKey: SESSION,
    connection: {},
    knownPaths: () => null,
    statPaths,
    ...rest,
  } as TestResolver;
}

async function settle() {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(50);
  await Promise.resolve();
}

describe("chat file link resolution", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("links listed paths at once and renders an unresolved path as written", async () => {
    vi.useFakeTimers();
    const root = mountMessages({
      markdown: "Wrote scratch/MOLTING-FOLLOWUP.json and src/app.ts; see `MOLTING-FOLLOWUP.json`.",
    });
    const files = resolver({
      knownPaths: () =>
        chatFileLinkKnownPaths({
          root: "/workspace",
          files: [{ path: "src/app.ts", workspacePath: "src/app.ts" }],
        }),
    });
    const resolution = new ChatFileLinkResolution();
    resolution.attach(root, files);
    resolution.scan(true);

    const known = root.querySelector<HTMLElement>('a[data-file-path="src/app.ts"]');
    expect(known?.classList.contains("markdown-file-link")).toBe(true);
    expect(known?.getAttribute("role")).toBe("button");
    expect(known?.getAttribute("aria-haspopup")).toBe("menu");
    expect(known?.dataset.fileLinkState).toBe("open");
    // Unknown paths render unlinked while the single check is in flight.
    expect(stateOf(root, "scratch/MOLTING-FOLLOWUP.json")).toBe("pending");

    await settle();
    // Inline code is never a file link, so only the prose path is checked.
    expect(files.statPaths).toHaveBeenCalledExactlyOnceWith(SESSION, [
      "scratch/MOLTING-FOLLOWUP.json",
    ]);
    const missing = root.querySelector<HTMLElement>(
      '[data-file-ref-path="scratch/MOLTING-FOLLOWUP.json"]',
    );
    expect(missing?.tagName).toBe("SPAN");
    expect(missing?.dataset.fileLinkState).toBe("plain");
    expect(missing?.className).toBe("markdown-file-ref");
    expect(missing?.hasAttribute("role")).toBe(false);
    expect(missing?.hasAttribute("tabindex")).toBe(false);
    expect(missing?.textContent).toBe("scratch/MOLTING-FOLLOWUP.json");
    expect(root.querySelector("p > code")?.textContent).toBe("MOLTING-FOLLOWUP.json");
    expect(root.querySelectorAll("a[data-file-path]")).toHaveLength(1);
    resolution.detach();
  });

  it("asks once per render for every new message and never again on re-render", async () => {
    vi.useFakeTimers();
    const html = [
      "See docs/model-research/conclusions.md and /srv/elsewhere/build-info.json",
      "Also notes/todo.md",
    ];
    const files = resolver({ exists: ["/srv/elsewhere/build-info.json"] });
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: html[0]!, id: "m1" }, { markdown: html[1]!, id: "m2" });
    resolution.attach(root, files);
    await settle();

    expect(files.statPaths).toHaveBeenCalledExactlyOnceWith(SESSION, [
      "docs/model-research/conclusions.md",
      "/srv/elsewhere/build-info.json",
      "notes/todo.md",
    ]);
    expect(stateOf(root, "/srv/elsewhere/build-info.json")).toBe("open");
    expect(stateOf(root, "docs/model-research/conclusions.md")).toBe("plain");
    // A demoted link shows what was written, not the shortened chip label.
    const text = root.querySelector(".chat-text")?.textContent;
    expect(text).toContain("See docs/model-research/conclusions.md and");
    const outside = root.querySelector('a[data-file-path="/srv/elsewhere/build-info.json"]');
    expect(outside?.textContent).toBe("build-info.json");

    // Re-render: the transcript replaces message DOM with identical Markdown.
    for (const [index, bubble] of root.querySelectorAll(".chat-text").entries()) {
      bubble.innerHTML = toSanitizedMarkdownHtml(html[index]!, { fileLinks: true });
    }
    resolution.attach(root, files);
    await settle();
    expect(files.statPaths).toHaveBeenCalledOnce();
    expect(stateOf(root, "/srv/elsewhere/build-info.json")).toBe("open");
    expect(stateOf(root, "notes/todo.md")).toBe("plain");
    resolution.detach();
  });

  it("checks a path again when a later message cites it", async () => {
    vi.useFakeTimers();
    const exists: string[] = [];
    const files = resolver({
      statPaths: vi.fn(
        async (_sessionKey: string, paths: readonly string[]) =>
          new Map(paths.map((path) => [path, exists.includes(path)])),
      ),
    });
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: "I'll create notes/plan.md.", id: "m1" });
    resolution.attach(root, files);
    await settle();
    expect(stateOf(root, "notes/plan.md")).toBe("plain");

    exists.push("notes/plan.md");
    appendMessages(root, [{ markdown: "Created notes/plan.md.", id: "m2" }]);
    resolution.attach(root, files);
    await settle();
    expect(files.statPaths).toHaveBeenCalledTimes(2);
    expect(fileRefs(root).map((element) => element.dataset.fileLinkState)).toEqual([
      "plain",
      "open",
    ]);
    resolution.detach();
  });

  it("waits for a streaming reply to settle and keeps authored labels", async () => {
    vi.useFakeTimers();
    const files = resolver();
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: "Read [the plan](docs/plan.md)", streaming: true });
    const parserLink = root.querySelector("a[data-file-path]");
    resolution.attach(root, files);
    await settle();
    // Lit still renders the streaming tail, so its elements stay exactly as parsed.
    expect(files.statPaths).not.toHaveBeenCalled();
    expect(root.querySelector("a[data-file-path]")).toBe(parserLink);
    expect(parserLink?.hasAttribute("data-file-link-state")).toBe(false);

    root.querySelector(".chat-bubble")?.classList.remove("streaming");
    resolution.attach(root, files);
    await settle();
    expect(files.statPaths).toHaveBeenCalledExactlyOnceWith(SESSION, ["docs/plan.md"]);
    expect(stateOf(root, "docs/plan.md")).toBe("plain");
    expect(root.querySelector("[data-file-ref-path]")?.textContent).toBe("the plan");
    resolution.detach();
  });

  it("checks other sessions' messages against their own session and caps each request", async () => {
    vi.useFakeTimers();
    const many = Array.from({ length: 70 }, (_, index) => `src/file-${index}.ts`).join(" ");
    const files = resolver();
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages(
      { markdown: many },
      { markdown: "reports/index.html", session: "agent:research:report" },
    );
    resolution.attach(root, files);
    await settle();

    const calls = files.statPaths.mock.calls as [string, string[]][];
    expect(calls.map(([sessionKey, paths]) => [sessionKey, paths.length])).toEqual([
      [SESSION, 64],
      [SESSION, 6],
      ["agent:research:report", 1],
    ]);
    resolution.detach();
  });

  it("keeps a failed check unlinked until the next connection without calling it missing", async () => {
    vi.useFakeTimers();
    const failing = resolver({
      statPaths: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: "src/app.ts", id: "m1" });
    resolution.attach(root, failing);
    await settle();
    expect(stateOf(root, "src/app.ts")).toBe("plain");
    resolution.attach(root, failing);
    await settle();
    expect(failing.statPaths).toHaveBeenCalledOnce();

    // Next connection (a new hello): the path is checked again.
    const reconnected = resolver({ exists: ["src/app.ts"], connection: {} });
    resolution.attach(root, reconnected);
    await settle();
    expect(reconnected.statPaths).toHaveBeenCalledOnce();
    expect(stateOf(root, "src/app.ts")).toBe("open");
    resolution.detach();
  });

  it("changes nothing while method support is unknown, as during a reconnect", async () => {
    vi.useFakeTimers();
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: "scratch/MOLTING-FOLLOWUP.json", id: "m1" });
    resolution.attach(root, resolver());
    await settle();
    expect(stateOf(root, "scratch/MOLTING-FOLLOWUP.json")).toBe("plain");

    resolution.attach(root, undefined);
    await settle();
    expect(stateOf(root, "scratch/MOLTING-FOLLOWUP.json")).toBe("plain");
    expect(root.querySelector("a[data-file-path]")).toBeNull();
    resolution.detach();
  });

  it("keeps parser links for a Gateway without the check and re-evaluates them later", async () => {
    vi.useFakeTimers();
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: "scratch/MOLTING-FOLLOWUP.json", id: "m1" });
    resolution.attach(root, { ...resolver(), statPaths: undefined });
    await settle();
    expect(stateOf(root, "scratch/MOLTING-FOLLOWUP.json")).toBe("unchecked");
    expect(root.querySelector("a[data-file-path]")?.getAttribute("role")).toBe("button");

    const files = resolver();
    resolution.attach(root, files);
    await settle();
    expect(files.statPaths).toHaveBeenCalledOnce();
    expect(stateOf(root, "scratch/MOLTING-FOLLOWUP.json")).toBe("plain");
    resolution.detach();
  });

  it("shares answers with every live transcript on the same connection", async () => {
    vi.useFakeTimers();
    const files = resolver({ exists: ["src/app.ts"] });
    const left = new ChatFileLinkResolution();
    const right = new ChatFileLinkResolution();
    const leftRoot = mountMessages({ markdown: "src/app.ts", id: "m1" });
    const rightRoot = mountMessages({ markdown: "src/app.ts", id: "m1" });
    left.attach(leftRoot, files);
    right.attach(rightRoot, files);
    await settle();
    expect(files.statPaths).toHaveBeenCalledOnce();
    expect(stateOf(leftRoot, "src/app.ts")).toBe("open");
    expect(stateOf(rightRoot, "src/app.ts")).toBe("open");
    left.detach();
    right.detach();
  });

  it("never restarts checks when split panes count connection epochs differently", async () => {
    vi.useFakeTimers();
    const connection = {};
    const left = new ChatFileLinkResolution();
    const right = new ChatFileLinkResolution();
    // Each pane counts its own connectionEpoch; only the shared connection identity counts.
    const leftFiles = Object.assign(resolver({ connection }), { epoch: 1 });
    const rightFiles = Object.assign(resolver({ connection }), { epoch: 3 });
    const leftRoot = mountMessages({ markdown: "scratch/missing-left.json", id: "m1" });
    const rightRoot = mountMessages({ markdown: "scratch/missing-right.json", id: "m2" });
    left.attach(leftRoot, leftFiles);
    right.attach(rightRoot, rightFiles);
    await settle();
    await settle();
    await settle();
    expect(leftFiles.statPaths).toHaveBeenCalledOnce();
    expect(rightFiles.statPaths).toHaveBeenCalledOnce();
    expect(stateOf(leftRoot, "scratch/missing-left.json")).toBe("plain");
    expect(stateOf(rightRoot, "scratch/missing-right.json")).toBe("plain");
    left.detach();
    right.detach();
  });

  it("ignores ordinary links that only carry a file-path attribute", async () => {
    vi.useFakeTimers();
    const root = mountMessages({ markdown: "[Guide](https://example.com/guide)" });
    const link = root.querySelector("a");
    link?.setAttribute("data-file-path", "guide");
    const files = resolver();
    const resolution = new ChatFileLinkResolution();
    resolution.attach(root, files);
    await settle();
    expect(files.statPaths).not.toHaveBeenCalled();
    expect(root.querySelector("a")).toBe(link);
    expect(link?.hasAttribute("data-file-link-state")).toBe(false);
    resolution.detach();
  });

  it("leaves links unchanged without a resolver", async () => {
    vi.useFakeTimers();
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: "scratch/MOLTING-FOLLOWUP.json" });
    resolution.attach(root, undefined);
    await settle();
    expect(root.querySelector("a[data-file-path]")?.classList.contains("markdown-file-link")).toBe(
      true,
    );
    resolution.detach();
  });

  it("builds known paths from touched files, workspace paths and browser rows", () => {
    const known = chatFileLinkKnownPaths({
      root: "/workspace/",
      files: [
        { path: "./ui/chat.ts", workspacePath: "ui/chat.ts" },
        { path: "/outside/build-info.json", workspacePath: "/outside/build-info.json" },
        { path: "gone.md", missing: true },
      ],
      browser: {
        entries: [
          { path: "docs", kind: "directory" },
          { path: "README.md", kind: "file" },
        ],
      },
    });
    expect([...known].toSorted()).toEqual([
      "/outside/build-info.json",
      "/workspace/README.md",
      "/workspace/ui/chat.ts",
      "README.md",
      "ui/chat.ts",
    ]);
  });
});
