/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { projectSubagentStatus } from "../chat-subagent-wait.ts";
import { resetChatViewState } from "../chat-view-state.ts";
import { createChatProps } from "../chat-view.test-helpers.ts";
import { renderChat } from "../chat-view.ts";
import { ChatSubagentPill, SUBAGENT_PILL_HOLD_MS } from "./chat-subagent-pill.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

const parent: GatewaySessionRow = {
  key: "main",
  kind: "direct",
  hasActiveRun: false,
  hasActiveSubagentRun: true,
  startedAt: 1_000,
};

function child(
  id: string,
  label: string,
  patch: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key: `agent:main:subagent:${id}`,
    kind: "direct",
    classification: "subagent",
    spawnedBy: parent.key,
    label,
    hasActiveRun: true,
    activeRunIds: [`${id}-run`],
    createdAt: 2_000,
    ...patch,
  };
}

const backend = child("backend", "Backend implementation", { createdAt: 2_000 });
const review = child("review", "Review accessibility", {
  createdAt: 3_000,
  status: "queued",
  hasActiveRun: false,
  activeRunIds: [],
});

function rowsFor(children: readonly GatewaySessionRow[]) {
  return projectSubagentStatus(
    {
      selectedSession: parent,
      messages: [],
      subagentSessions: children,
      subagentSessionsHydrated: true,
    },
    false,
  ).activity;
}

beforeEach(() => {
  installTranscriptDomMocks();
});

afterEach(() => {
  vi.useRealTimers();
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("running subagents above the composer", () => {
  it("leaves the message list and opens from a pill above the composer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    onTestFinished(() => {
      render(null, container);
      container.remove();
    });
    const onOpenSubagent = vi.fn();
    const onOpenSubagents = vi.fn();
    render(
      renderChat(
        createChatProps({
          sessionKey: parent.key,
          selectedSession: parent,
          subagentSessions: [backend, review],
          subagentSessionsHydrated: true,
          onOpenSubagent,
          onOpenSubagents,
        }),
      ),
      container,
    );
    await Promise.all(
      [...container.querySelectorAll<HTMLElement & { updateComplete?: Promise<unknown> }>("*")]
        .map((element) => element.updateComplete)
        .filter(Boolean),
    );

    // The parent visibly waits in the transcript, but its children are not rows there.
    const thread = container.querySelector(".chat-thread");
    expect(thread?.querySelector(".chat-working-indicator")).not.toBeNull();
    expect(thread?.querySelector("openclaw-chat-subagent-activity")).toBeNull();
    expect(thread?.querySelector("[data-subagent-session-key]")).toBeNull();

    const pill = container.querySelector("openclaw-chat-subagent-pill");
    expect(pill).toBeInstanceOf(ChatSubagentPill);

    // The pill sits directly above the input, outside the scrolling context stack,
    // and counts the same rows.
    expect(pill?.closest(".chat-footer .agent-chat__composer-shell")).not.toBeNull();
    expect(pill?.closest(".chat-footer__context")).toBeNull();
    expect(pill?.nextElementSibling?.classList.contains("agent-chat__input")).toBe(true);
    const toggle = pill?.querySelector<HTMLButtonElement>(".chat-subagent-pill__toggle");
    expect(toggle?.textContent?.trim()).toBe("2 agents");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(pill?.querySelector("[data-subagent-session-key]")).toBeNull();

    toggle?.click();
    await pill?.updateComplete;
    const list = pill?.querySelector<HTMLElement>("openclaw-chat-subagent-activity");
    await (list as { updateComplete?: Promise<unknown> } | null)?.updateComplete;
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const rows = [...(pill?.querySelectorAll<HTMLElement>("[data-subagent-session-key]") ?? [])];
    expect(rows.map((row) => row.dataset.subagentSessionKey)).toEqual([backend.key, review.key]);
    expect(pill?.textContent).toContain("Backend implementation");
    expect(pill?.textContent).toContain("Queued");

    rows[0]?.querySelector("button")?.click();
    expect(onOpenSubagent).toHaveBeenCalledWith(backend.key);
    await pill?.updateComplete;
    // Opening one closes the list; the pill stays for the rest.
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(pill?.querySelector("[data-subagent-session-key]")).toBeNull();

    toggle?.click();
    await pill?.updateComplete;
    pill?.querySelector<HTMLButtonElement>(".chat-subagent-pill__all")?.click();
    expect(onOpenSubagents).toHaveBeenCalledTimes(1);
  });

  it("is hidden with no running subagents", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    onTestFinished(() => {
      render(null, container);
      container.remove();
    });
    render(
      renderChat(
        createChatProps({
          sessionKey: parent.key,
          selectedSession: { ...parent, hasActiveSubagentRun: false },
          subagentSessions: [],
          subagentSessionsHydrated: true,
        }),
      ),
      container,
    );
    const pill = container.querySelector("openclaw-chat-subagent-pill");
    expect(pill).toBeInstanceOf(ChatSubagentPill);
    await pill?.updateComplete;
    expect(pill?.querySelector(".chat-subagent-pill__toggle")).toBeNull();
    expect(pill?.childElementCount).toBe(0);
  });
});

describe("subagent pill count", () => {
  async function mount(rows = rowsFor([backend, review])) {
    const pill = new ChatSubagentPill();
    pill.sessionKey = parent.key;
    pill.rows = rows;
    document.body.append(pill);
    onTestFinished(() => pill.remove());
    await pill.updateComplete;
    return pill;
  }
  const label = (pill: ChatSubagentPill) =>
    pill.querySelector(".chat-subagent-pill__toggle")?.textContent?.trim() ?? null;

  it("names one agent and shows the running claw only while one runs", async () => {
    const pill = await mount(rowsFor([backend]));
    expect(label(pill)).toBe("1 agent");
    expect(pill.querySelector(".chat-subagent-pill__icon.chat-reading-indicator")).not.toBeNull();
    pill.rows = rowsFor([review]);
    await pill.updateComplete;
    expect(label(pill)).toBe("1 agent");
    expect(pill.querySelector(".chat-subagent-pill__icon.chat-reading-indicator")).toBeNull();
  });

  it("holds a dropping count for the debounce window and rises at once", async () => {
    vi.useFakeTimers();
    const pill = await mount();
    expect(label(pill)).toBe("2 agents");

    // A gap between events: the rows vanish and come back within the window.
    pill.rows = [];
    await pill.updateComplete;
    expect(label(pill)).toBe("2 agents");
    vi.advanceTimersByTime(SUBAGENT_PILL_HOLD_MS / 2);
    pill.rows = rowsFor([backend, review]);
    await pill.updateComplete;
    vi.advanceTimersByTime(SUBAGENT_PILL_HOLD_MS);
    await pill.updateComplete;
    expect(label(pill)).toBe("2 agents");

    // A real drop lands only after the window.
    pill.rows = rowsFor([backend]);
    await pill.updateComplete;
    expect(label(pill)).toBe("2 agents");
    vi.advanceTimersByTime(SUBAGENT_PILL_HOLD_MS - 1);
    await pill.updateComplete;
    expect(label(pill)).toBe("2 agents");
    vi.advanceTimersByTime(1);
    await pill.updateComplete;
    expect(label(pill)).toBe("1 agent");

    pill.rows = [];
    await pill.updateComplete;
    expect(label(pill)).toBe("1 agent");
    vi.advanceTimersByTime(SUBAGENT_PILL_HOLD_MS);
    await pill.updateComplete;
    expect(label(pill)).toBeNull();
    expect(pill.childElementCount).toBe(0);

    pill.rows = rowsFor([backend, review]);
    await pill.updateComplete;
    expect(label(pill)).toBe("2 agents");
  });

  it("restarts the window for each row that leaves", async () => {
    vi.useFakeTimers();
    const pill = await mount();
    pill.rows = rowsFor([backend]);
    await pill.updateComplete;
    vi.advanceTimersByTime(SUBAGENT_PILL_HOLD_MS - 100);
    // The last row drops out briefly near the end of the first row's window.
    pill.rows = [];
    await pill.updateComplete;
    vi.advanceTimersByTime(100);
    await pill.updateComplete;
    expect(label(pill)).toBe("1 agent");
    vi.advanceTimersByTime(300);
    pill.rows = rowsFor([backend]);
    await pill.updateComplete;
    expect(label(pill)).toBe("1 agent");
    vi.advanceTimersByTime(SUBAGENT_PILL_HOLD_MS);
    await pill.updateComplete;
    expect(label(pill)).toBe("1 agent");
  });

  it("never counts held rows above what it already showed", async () => {
    vi.useFakeTimers();
    const tests = child("tests", "UI regression tests", { createdAt: 4_000 });
    const docs = child("docs", "Docs update", { createdAt: 5_000 });
    const pill = await mount(rowsFor([backend, review, tests]));
    expect(label(pill)).toBe("3 agents");
    pill.rows = rowsFor([backend, docs]);
    await pill.updateComplete;
    expect(label(pill)).toBe("3 agents");
    vi.advanceTimersByTime(SUBAGENT_PILL_HOLD_MS);
    await pill.updateComplete;
    expect(label(pill)).toBe("2 agents");
  });

  it("does not repaint for a fresh projection of the same rows", async () => {
    const pill = await mount();
    const repaint = vi.spyOn(pill, "render");
    pill.rows = rowsFor([backend, review]);
    await pill.updateComplete;
    expect(repaint).not.toHaveBeenCalled();
    pill.rows = rowsFor([{ ...backend, label: "Backend API" }, review]);
    await pill.updateComplete;
    expect(repaint).toHaveBeenCalledTimes(1);
  });

  it("does not carry a held count into another session", async () => {
    vi.useFakeTimers();
    const pill = await mount();
    pill.rows = [];
    pill.sessionKey = "agent:main:other";
    await pill.updateComplete;
    expect(label(pill)).toBeNull();
  });

  it("closes the list with Escape and returns focus to the pill", async () => {
    const pill = await mount();
    const toggle = pill.querySelector<HTMLButtonElement>(".chat-subagent-pill__toggle");
    toggle?.click();
    await pill.updateComplete;
    expect(pill.querySelector(".chat-subagent-pill__sheet")).not.toBeNull();
    pill
      .querySelector(".chat-subagent-pill")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await pill.updateComplete;
    expect(pill.querySelector(".chat-subagent-pill__sheet")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});
