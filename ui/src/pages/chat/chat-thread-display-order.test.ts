// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { createChatDisplayOrderState, holdChatDisplayOrder } from "./chat-thread-display-order.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";

afterEach(() => {
  resetChatThreadState();
});

function message(id: string, role: string, text: string, timestamp: number) {
  return { id, role, content: [{ type: "text", text }], timestamp };
}

/** The transcript as the reader sees it: every visible text, top to bottom. */
function screen(items: ReturnType<typeof buildItems>): string[] {
  return items.flatMap((item) => {
    if (item.kind === "group") {
      return item.messages.map((entry) => extractTextCached(entry.message) ?? "");
    }
    if (item.kind === "stream") {
      return [item.text];
    }
    if (item.kind === "notice") {
      return [item.text];
    }
    return [];
  });
}

const u1 = message("u1", "user", "first question", 1_000);
const a1 = message("a1", "assistant", "first answer", 2_000);
const u2 = message("u2", "user", "second question", 3_000);
const a2 = message("a2", "assistant", "second answer", 4_000);

describe("rendered chat order (DER-615)", () => {
  it("keeps rendered rows in place when a history reconcile re-sorts them", () => {
    expect(screen(buildItems({ messages: [u1, a1, u2, a2] }))).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ]);
    // A full read (re-entry, foreground, cursor reset) returns another order,
    // e.g. a queued prompt sorted by its recorded time above an earlier reply.
    expect(screen(buildItems({ messages: [u1, u2, a1, a2] }))).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ]);
  });

  it("lands a new item with an older timestamp after the last rendered row", () => {
    buildItems({ messages: [u1, a1, u2, a2] });
    const completion = message("sub", "assistant", "subagent finished", 1_500);
    expect(screen(buildItems({ messages: [u1, completion, a1, u2, a2] }))).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
      "subagent finished",
    ]);
  });

  it("pages older history in above the rendered rows", () => {
    buildItems({ messages: [u2, a2] });
    expect(screen(buildItems({ messages: [u1, a1, u2, a2] }))).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ]);
  });

  it("keeps the reply being generated after the rows that landed meanwhile", () => {
    buildItems({
      messages: [u1, a1, u2],
      runId: "run-2",
      stream: "Working on",
      streamStartedAt: 3_500,
    });
    const notice = message("n1", "assistant", "worker update", 2_500);
    expect(
      screen(
        buildItems({
          messages: [u1, notice, a1, u2],
          runId: "run-2",
          stream: "Working on it",
          streamStartedAt: 3_500,
        }),
      ),
    ).toEqual([
      "first question",
      "first answer",
      "second question",
      "worker update",
      "Working on it",
    ]);
  });

  it("shows the recorded order again after an explicit Reload", () => {
    buildItems({ messages: [u1, a1, u2, a2] });
    buildItems({ messages: [u1, u2, a1, a2] });
    // Reload starts a fresh document, and with it a fresh on-screen order.
    resetChatThreadState();
    expect(screen(buildItems({ messages: [u1, u2, a1, a2] }))).toEqual([
      "first question",
      "second question",
      "first answer",
      "second answer",
    ]);
  });
});

function row(key: string, role: string, text: string, toolCallId?: string): ChatItem {
  return {
    kind: "message",
    key,
    message: { role, content: [{ type: "text", text }], ...(toolCallId ? { toolCallId } : {}) },
  };
}

const keys = (items: readonly ChatItem[]) => items.map((item) => item.key);

describe("holdChatDisplayOrder", () => {
  it("lets a stored copy take the slot of the placeholder it replaces", () => {
    const state = createChatDisplayOrderState();
    holdChatDisplayOrder(
      [
        row("u1", "user", "go"),
        row("pending-send:1", "user", "and then?"),
        row("live-tool", "toolResult", "ok", "call-1"),
        row("n1", "assistant", "worker update"),
      ],
      state,
    );
    expect(
      keys(
        holdChatDisplayOrder(
          [
            row("u1", "user", "go"),
            row("tool:call-1", "toolResult", "ok (stored)", "call-1"),
            row("n1", "assistant", "worker update"),
            row("send:1", "user", "and then?"),
          ],
          state,
        ),
      ),
    ).toEqual(["u1", "send:1", "tool:call-1", "n1"]);
  });

  it("fills a removed row's gap with the reconciled row between the same neighbors", () => {
    const state = createChatDisplayOrderState();
    holdChatDisplayOrder(
      [row("a", "user", "a"), row("b", "assistant", "draft"), row("c", "user", "c")],
      state,
    );
    expect(
      keys(
        holdChatDisplayOrder(
          [row("a", "user", "a"), row("b2", "assistant", "final text"), row("c", "user", "c")],
          state,
        ),
      ),
    ).toEqual(["a", "b2", "c"]);
  });

  it("returns a row that left and came back to its old place", () => {
    const state = createChatDisplayOrderState();
    holdChatDisplayOrder(
      [row("a", "user", "a"), row("b", "assistant", "b"), row("c", "user", "c")],
      state,
    );
    holdChatDisplayOrder([row("a", "user", "a"), row("c", "user", "c")], state);
    holdChatDisplayOrder(
      [row("a", "user", "a"), row("c", "user", "c"), row("d", "user", "d")],
      state,
    );
    expect(
      keys(
        holdChatDisplayOrder(
          [
            row("a", "user", "a"),
            row("c", "user", "c"),
            row("d", "user", "d"),
            row("b", "assistant", "b"),
          ],
          state,
        ),
      ),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps floating live rows last and out of the ledger", () => {
    const state = createChatDisplayOrderState();
    const indicator: ChatItem = { kind: "reading-indicator", key: "working", startedAt: 1 };
    holdChatDisplayOrder([row("a", "user", "a"), indicator], state, new Set(["working"]));
    expect(
      keys(
        holdChatDisplayOrder(
          [row("a", "user", "a"), row("t", "toolResult", "t", "call-t"), indicator],
          state,
          new Set(["working"]),
        ),
      ),
    ).toEqual(["a", "t", "working"]);
    expect(state.ledger).toEqual(["a", "t"]);
  });
});
