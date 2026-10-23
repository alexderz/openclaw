/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import {
  chatFileLinkKnownPaths,
  ChatFileLinkResolution,
  type ChatFileLinkResolver,
} from "./chat-file-link-resolution.ts";

const SESSION = "agent:main:main";

function mountMessages(...messages: { markdown: string; streaming?: boolean; session?: string }[]) {
  const root = document.body.appendChild(document.createElement("div"));
  root.className = "chat-thread";
  for (const message of messages) {
    const bubble = root.appendChild(document.createElement("div"));
    bubble.className = message.streaming ? "chat-bubble streaming" : "chat-bubble";
    if (message.session) {
      bubble.dataset.fileSessionKey = message.session;
    }
    const text = bubble.appendChild(document.createElement("div"));
    text.className = "chat-text";
    text.innerHTML = toSanitizedMarkdownHtml(message.markdown, { fileLinks: true });
  }
  return root;
}

function fileRefs(root: ParentNode) {
  return [...root.querySelectorAll<HTMLAnchorElement>("a[data-file-path], a[data-file-ref-path]")];
}

function stateOf(root: ParentNode, path: string) {
  const anchor = fileRefs(root).find(
    (candidate) => (candidate.dataset.filePath ?? candidate.dataset.fileRefPath) === path,
  );
  return anchor?.dataset.fileLinkState;
}

function resolver(
  overrides: Partial<ChatFileLinkResolver> & { exists?: readonly string[] } = {},
): ChatFileLinkResolver & { statPaths: ReturnType<typeof vi.fn> } {
  const exists = new Set(overrides.exists ?? []);
  const statPaths = vi.fn(
    async (_sessionKey: string, paths: readonly string[]) =>
      new Map(paths.map((path) => [path, exists.has(path)])),
  );
  return {
    sessionKey: SESSION,
    cacheOwner: {},
    knownPaths: () => null,
    statPaths,
    ...overrides,
  } as ChatFileLinkResolver & { statPaths: ReturnType<typeof vi.fn> };
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

  it("links listed paths at once and renders an unresolved bare filename as code", async () => {
    vi.useFakeTimers();
    const root = mountMessages({
      markdown: "Wrote `MOLTING-FOLLOWUP.json` and `src/app.ts`.",
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

    const known = root.querySelector<HTMLAnchorElement>('a[data-file-path="src/app.ts"]');
    expect(known?.classList.contains("markdown-file-link")).toBe(true);
    expect(known?.getAttribute("role")).toBe("button");
    expect(known?.dataset.fileLinkState).toBe("open");
    // Unknown paths render unlinked while the single check is in flight.
    const bare = root.querySelector<HTMLAnchorElement>(
      'a[data-file-ref-path="MOLTING-FOLLOWUP.json"]',
    );
    expect(bare?.dataset.fileLinkState).toBe("pending");

    await settle();
    expect(files.statPaths).toHaveBeenCalledExactlyOnceWith(SESSION, ["MOLTING-FOLLOWUP.json"]);
    expect(bare?.dataset.fileLinkState).toBe("plain");
    expect(bare?.classList.contains("markdown-file-link")).toBe(false);
    expect(bare?.hasAttribute("role")).toBe(false);
    expect(bare?.hasAttribute("tabindex")).toBe(false);
    expect(bare?.querySelector("code")?.textContent).toBe("MOLTING-FOLLOWUP.json");
    expect(root.querySelectorAll("a[data-file-path]")).toHaveLength(1);
    resolution.detach();
  });

  it("asks once per render for every new message and never again on re-render", async () => {
    vi.useFakeTimers();
    const html = [
      "See docs/model-research/conclusions.md and /srv/elsewhere/build-info.json",
      "Also `notes/todo.md`",
    ];
    const files = resolver({ exists: ["/srv/elsewhere/build-info.json"] });
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: html[0]! }, { markdown: html[1]! });
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
    const outside = root.querySelector<HTMLAnchorElement>(
      'a[data-file-path="/srv/elsewhere/build-info.json"]',
    );
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

  it("waits for a streaming reply to settle and keeps authored labels", async () => {
    vi.useFakeTimers();
    const files = resolver();
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: "Read [the plan](docs/plan.md)", streaming: true });
    resolution.attach(root, files);
    await settle();
    expect(files.statPaths).not.toHaveBeenCalled();
    expect(stateOf(root, "docs/plan.md")).toBe("pending");
    expect(root.querySelector("a")?.textContent).toBe("the plan");

    root.querySelector(".chat-bubble")?.classList.remove("streaming");
    resolution.attach(root, files);
    await settle();
    expect(files.statPaths).toHaveBeenCalledExactlyOnceWith(SESSION, ["docs/plan.md"]);
    expect(stateOf(root, "docs/plan.md")).toBe("plain");
    expect(root.querySelector("a")?.textContent).toBe("the plan");
    resolution.detach();
  });

  it("checks other sessions' messages against their own session and caps each request", async () => {
    vi.useFakeTimers();
    const many = Array.from({ length: 70 }, (_, index) => `\`src/file-${index}.ts\``).join(" ");
    const files = resolver();
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages(
      { markdown: many },
      { markdown: "`reports/index.html`", session: "agent:research:report" },
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

  it("keeps a failed check unlinked until the next connection", async () => {
    vi.useFakeTimers();
    const failing = resolver({
      statPaths: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: "`src/app.ts`" });
    resolution.attach(root, failing);
    await settle();
    expect(stateOf(root, "src/app.ts")).toBe("plain");
    resolution.attach(root, failing);
    await settle();
    expect(failing.statPaths).toHaveBeenCalledOnce();

    const reconnected = resolver({ exists: ["src/app.ts"] });
    resolution.attach(root, reconnected);
    resolution.scan(true);
    await settle();
    expect(reconnected.statPaths).toHaveBeenCalledOnce();
    expect(stateOf(root, "src/app.ts")).toBe("open");
    resolution.detach();
  });

  it("keeps parser links when the Gateway cannot check paths", async () => {
    vi.useFakeTimers();
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: "`MOLTING-FOLLOWUP.json`" });
    resolution.attach(root, { ...resolver(), statPaths: undefined });
    resolution.scan(true);
    expect(stateOf(root, "MOLTING-FOLLOWUP.json")).toBe("open");
    expect(root.querySelector("a[data-file-path]")?.getAttribute("role")).toBe("button");
    resolution.detach();
  });

  it("leaves links unchanged without a resolver", async () => {
    vi.useFakeTimers();
    const resolution = new ChatFileLinkResolution();
    const root = mountMessages({ markdown: "`MOLTING-FOLLOWUP.json`" });
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
