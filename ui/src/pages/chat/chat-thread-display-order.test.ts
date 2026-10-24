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

function message(id: string, role: string, text: string, timestamp: number, seq: number) {
  return { id, role, content: [{ type: "text", text }], timestamp, __openclaw: { seq } };
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

const u1 = message("u1", "user", "first question", 1_000, 1);
const a1 = message("a1", "assistant", "first answer", 2_000, 2);
const u2 = message("u2", "user", "second question", 3_000, 3);
const a2 = message("a2", "assistant", "second answer", 4_000, 4);

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
    // Recorded after every shown row, stamped with the time its work started.
    const completion = message("sub", "assistant", "subagent finished", 1_500, 5);
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

  it("lands a late arrival sorted above every shown row at the bottom", () => {
    buildItems({ messages: [u2, a2] });
    const late = message("late", "assistant", "late worker result", 500, 5);
    expect(screen(buildItems({ messages: [late, u2, a2] }))).toEqual([
      "second question",
      "second answer",
      "late worker result",
    ]);
  });

  it("keeps an input queued behind the run at the live edge", () => {
    const queued = {
      id: "input-q",
      runId: "run-q",
      acceptedAt: 3_000,
      state: "queued" as const,
      message: {
        role: "user",
        content: "queued follow-up",
        timestamp: 3_000,
        __openclaw: { id: "pending:input-q" },
      },
    };
    expect(screen(buildItems({ messages: [u1, a1], pendingInputs: [queued] }))).toEqual([
      "first question",
      "first answer",
      "queued follow-up",
    ]);
    const update = message("n1", "assistant", "worker update", 3_500, 3);
    expect(screen(buildItems({ messages: [u1, a1, update], pendingInputs: [queued] }))).toEqual([
      "first question",
      "first answer",
      "worker update",
      "queued follow-up",
    ]);
  });

  it("keeps the reply being generated after the rows that landed meanwhile", () => {
    buildItems({
      messages: [u1, a1, u2],
      runId: "run-2",
      stream: "Working on",
      streamStartedAt: 3_500,
    });
    const notice = message("n1", "assistant", "worker update", 2_500, 4);
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

function row(
  key: string,
  role: string,
  text: string,
  toolCallId?: string,
  runId?: string,
): ChatItem {
  return {
    kind: "message",
    key,
    message: {
      role,
      content: [{ type: "text", text }],
      ...(toolCallId ? { toolCallId } : {}),
      ...(runId ? { __openclaw: { runId } } : {}),
    },
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

  it("fills a removed row's gap with the same run's reconciled row", () => {
    const state = createChatDisplayOrderState();
    holdChatDisplayOrder(
      [
        row("a", "user", "a"),
        row("b", "assistant", "draft", undefined, "run-1"),
        row("c", "user", "c"),
      ],
      state,
    );
    expect(
      keys(
        holdChatDisplayOrder(
          [
            row("a", "user", "a"),
            row("b2", "assistant", "final text", undefined, "run-1"),
            row("c", "user", "c"),
          ],
          state,
        ),
      ),
    ).toEqual(["a", "b2", "c"]);
  });

  it("lands an unrelated row after the last shown row even where a row was removed", () => {
    const state = createChatDisplayOrderState();
    holdChatDisplayOrder(
      [
        row("a", "user", "a"),
        row("b", "assistant", "draft", undefined, "run-1"),
        row("c", "user", "c"),
      ],
      state,
    );
    expect(
      keys(
        holdChatDisplayOrder(
          [
            row("a", "user", "a"),
            row("x", "assistant", "worker update", undefined, "run-other"),
            row("c", "user", "c"),
          ],
          state,
        ),
      ),
    ).toEqual(["a", "c", "x"]);
  });

  it("never gives a removed row's slot to equal text from another run", () => {
    const state = createChatDisplayOrderState();
    holdChatDisplayOrder(
      [
        row("a", "user", "a"),
        row("done-a", "assistant", "Done", undefined, "run-a"),
        row("c", "user", "c"),
      ],
      state,
    );
    expect(
      keys(
        holdChatDisplayOrder(
          [
            row("a", "user", "a"),
            row("c", "user", "c"),
            row("done-b", "assistant", "Done", undefined, "run-b"),
          ],
          state,
        ),
      ),
    ).toEqual(["a", "c", "done-b"]);
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
    holdChatDisplayOrder([row("a", "user", "a"), indicator], state, {
      floating: new Set(["working"]),
    });
    expect(
      keys(
        holdChatDisplayOrder(
          [row("a", "user", "a"), row("t", "toolResult", "t", "call-t"), indicator],
          state,
          { floating: new Set(["working"]) },
        ),
      ),
    ).toEqual(["a", "t", "working"]);
    expect(state.ledger).toEqual(["a", "t"]);
  });
});

describe("a question loaded after its local copy was shown (DER-623)", () => {
  // The shape of Alex's chat: a question, a steered follow-up inside the
  // running reply, then a night of other runs.
  function stored(
    seq: number,
    role: "user" | "assistant",
    text: string,
    run: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      role,
      content: [{ type: "text", text }],
      timestamp: 1_000 * seq,
      ...(role === "user" ? { idempotencyKey: `${run}:user` } : {}),
      __openclaw: {
        id: `row-${seq}`,
        seq,
        ...(role === "user" ? { idempotencyKey: `${run}:user` } : { runId: run }),
        ...extra,
      },
    };
  }
  const mini = stored(10, "user", "Wat dis? MiniCPM", "run-a");
  const miniAnswer = stored(11, "assistant", "A vision model with a small active set", "run-a");
  const testIt = stored(12, "user", "Test it", "run-b");
  const started = stored(13, "assistant", "I'll start with test 1", "run-b");
  const flint = stored(14, "user", "Then, how has the Flint model done?", "steer-c", {
    steerTargetRunId: "run-b",
  });
  const flintAnswer = stored(15, "assistant", "Flint looks promising on speed", "run-b");
  const graded = stored(40, "assistant", "Flint is now graded", "announce-1");
  const yo = stored(41, "user", "Yo", "run-d");
  const yoAnswer = stored(42, "assistant", "Yo Alex", "run-d");
  const older = [mini, miniAnswer, testIt, started, flint, flintAnswer];
  const newest = [graded, yo, yoAnswer];
  const sendOrder = [...older, ...newest].map((entry) => entry.content[0]!.text);

  // The steered send's bubble before its stored row is read: same send key, no sequence.
  const flintCopy = {
    role: "user",
    content: [{ type: "text", text: "Then, how has the Flint model done?" }],
    timestamp: 14_000,
    __openclaw: { idempotencyKey: "steer-c:user", steerTargetRunId: "run-b" },
  };
  // The same send restored from the outbox after a Reload, its delivery not yet settled.
  const flintOutbox = {
    id: "outbox-flint",
    text: "Then, how has the Flint model done?",
    createdAt: 14_000,
    sessionKey: "main",
    sendState: "sending" as const,
    sendAttempts: 1,
    sendRunId: "steer-c",
    sendSubmittedAtMs: 14_000,
    sendRequestStartedAtMs: 14_000,
  };

  it("keeps a steered question above its answer when the older page loads", () => {
    buildItems({ messages: [...newest, flintCopy] });
    // Show earlier: the stored question and its answer arrive with that page.
    expect(screen(buildItems({ messages: [...older, ...newest] }))).toEqual(sendOrder);
  });

  it("keeps the question above its answer when the page starts inside the answer", () => {
    // The newest page begins between the question and its answer.
    buildItems({ messages: [flintAnswer, ...newest, flintCopy] });
    expect(screen(buildItems({ messages: [...older, ...newest] }))).toEqual(sendOrder);
  });

  it("restores send order after a Reload with the send still in the outbox", () => {
    buildItems({ messages: [...newest, flintCopy] });
    buildItems({ messages: [...older, ...newest] });
    resetChatThreadState();
    // The reloaded document reads the newest page first; the outbox restores the send.
    buildItems({ messages: newest, queue: [flintOutbox] });
    expect(screen(buildItems({ messages: [...older, ...newest], queue: [flintOutbox] }))).toEqual(
      sendOrder,
    );
    // Once the send is retired, every row keeps its place.
    expect(screen(buildItems({ messages: [...older, ...newest] }))).toEqual(sendOrder);
  });

  it("never lifts the newest rows above older history", () => {
    buildItems({ messages: newest, queue: [flintOutbox] });
    const shown = screen(buildItems({ messages: [...older, ...newest] }));
    expect(shown.slice(-3)).toEqual(["Flint is now graded", "Yo", "Yo Alex"]);
    expect(shown.indexOf("Then, how has the Flint model done?") + 1).toBe(
      shown.indexOf("Flint looks promising on speed"),
    );
  });
});

describe("holdChatDisplayOrder with stored rows (DER-623)", () => {
  function storedRow(key: string, role: string, text: string, seq: number): ChatItem {
    return {
      kind: "message",
      key,
      message: { role, content: [{ type: "text", text }], __openclaw: { id: key, seq } },
    };
  }
  function localCopy(key: string, text: string): ChatItem {
    return { kind: "message", key, message: { role: "user", content: [{ type: "text", text }] } };
  }

  it("keeps a send at the live edge in its slot when its stored row is the newest", () => {
    const state = createChatDisplayOrderState();
    const a = storedRow("a", "assistant", "a", 1);
    holdChatDisplayOrder([a, localCopy("send", "go on")], state);
    const b = storedRow("b", "assistant", "b", 3);
    expect(
      keys(holdChatDisplayOrder([a, b, storedRow("send", "user", "go on", 2)], state)),
    ).toEqual(["a", "send", "b"]);
  });

  it("still lands a late arrival at the bottom while stored rows anchor the view", () => {
    const state = createChatDisplayOrderState();
    const rows = [storedRow("a", "user", "a", 1), storedRow("b", "assistant", "b", 2)];
    holdChatDisplayOrder(rows, state);
    const late = storedRow("late", "assistant", "late", 3);
    expect(keys(holdChatDisplayOrder([late, ...rows], state))).toEqual(["a", "b", "late"]);
  });

  it("places rows that share a sequence by their source order", () => {
    const state = createChatDisplayOrderState();
    const text = storedRow("text", "assistant", "text", 5);
    const tool = storedRow("tool", "toolResult", "tool", 5);
    const next = storedRow("next", "user", "next", 6);
    holdChatDisplayOrder([tool, next], state);
    const question = storedRow("q", "user", "q", 4);
    expect(keys(holdChatDisplayOrder([question, text, tool, next], state))).toEqual([
      "q",
      "text",
      "tool",
      "next",
    ]);
  });

  it("loads an older page above a notice that opens the view", () => {
    const state = createChatDisplayOrderState();
    const notice: ChatItem = { kind: "notice", key: "notice", text: "delivery blocked", timestamp: 0 };
    const after = storedRow("after", "assistant", "after", 10);
    holdChatDisplayOrder([notice, after], state);
    const older = [storedRow("q", "user", "q", 1), storedRow("a", "assistant", "a", 2)];
    expect(keys(holdChatDisplayOrder([...older, notice, after], state))).toEqual([
      "q",
      "a",
      "notice",
      "after",
    ]);
  });

  it("keeps a history row without a sequence at the bottom when no older page loaded", () => {
    const state = createChatDisplayOrderState();
    const rows = [storedRow("a", "user", "a", 1), storedRow("b", "assistant", "b", 2)];
    holdChatDisplayOrder(rows, state);
    const card: ChatItem = { kind: "notice", key: "card", text: "late card", timestamp: 0 };
    expect(keys(holdChatDisplayOrder([card, ...rows], state))).toEqual(["a", "b", "card"]);
  });

  it("moves a local copy below a stored row recorded before it", () => {
    const state = createChatDisplayOrderState();
    const reply = storedRow("reply", "assistant", "reply", 10);
    // The bubble was drawn above a reply its stored row turns out to follow.
    holdChatDisplayOrder([localCopy("send:q", "follow-up"), reply], state);
    const question = storedRow("send:q", "user", "follow-up", 11);
    expect(keys(holdChatDisplayOrder([question, reply], state))).toEqual(["reply", "send:q"]);
  });

  it("re-places a local copy whose slot another key took once its stored row is older", () => {
    const state = createChatDisplayOrderState();
    const newest = [storedRow("n1", "assistant", "n1", 20), storedRow("n2", "user", "n2", 21)];
    holdChatDisplayOrder([...newest, localCopy("pending-send:q", "how is Flint?")], state);
    // The stored question takes the placeholder's slot by text, then turns out older.
    const question = storedRow("send:q", "user", "how is Flint?", 5);
    const answer = storedRow("answer", "assistant", "Flint is fast", 6);
    expect(keys(holdChatDisplayOrder([question, answer, ...newest], state))).toEqual([
      "send:q",
      "answer",
      "n1",
      "n2",
    ]);
  });
});
