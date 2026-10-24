/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatInto, renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => installTranscriptDomMocks());
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

// A Gateway turn holds the session; follow-ups it accepted wait for their own turns.
const activeRun = "run-message-1";
const history = [
  {
    role: "user",
    content: "Message 1",
    timestamp: 1,
    __openclaw: { id: "user-1", idempotencyKey: `${activeRun}:user` },
  },
  {
    role: "assistant",
    content: "Got Message 1. Send Message 2 now.",
    timestamp: 2,
    runId: activeRun,
    __openclaw: { id: "assistant-1", runId: activeRun },
  },
];

function sent(id: string, text: string, createdAt: number): ChatQueueItem {
  // A follow-up whose chat.send was acknowledged as started while another run is active.
  return {
    id,
    text,
    createdAt,
    sessionKey: "main",
    sendState: "sending",
    sendAttempts: 1,
    sendRunId: `run-${id}`,
    sendSubmittedAtMs: createdAt,
    sendRequestStartedAtMs: createdAt,
  };
}

function trayTexts(container: Element): string[] {
  return Array.from(container.querySelectorAll(".chat-queue__text"), (node) =>
    (node.textContent ?? "").trim(),
  );
}

function transcriptUserTexts(container: Element): string[] {
  return Array.from(container.querySelectorAll(".chat-thread .chat-group.user"), (node) =>
    (node.textContent ?? "").replace(/\s+/g, " ").trim(),
  ).flatMap((text) => ["Message 1", "Message 2", "Message 3"].filter((m) => text.includes(m)));
}

function transcriptOrder(container: Element): string[] {
  // Message rows only; the running indicator is not an input.
  return Array.from(container.querySelectorAll(".chat-thread .chat-group"), (node) => {
    const text = (node.textContent ?? "").replace(/\s+/g, " ");
    const label = ["Got Message 1", "Message 1", "Message 2", "Message 3"].find((m) =>
      text.includes(m),
    );
    return label ? `${node.classList.contains("user") ? "user" : "assistant"}:${label}` : "";
  }).filter(Boolean);
}

function startedInput(id: string, text: string, acceptedAt: number) {
  // Accepted and started by the Gateway, not yet committed to the transcript.
  return {
    id: `input-${id}`,
    runId: `run-${id}`,
    acceptedAt,
    state: "queued" as const,
    message: { role: "user", content: text },
  };
}

function serverQueued(id: string, text: string, acceptedAt: number) {
  return {
    id: `input-${id}`,
    runId: `run-${id}`,
    acceptedAt,
    state: "queued" as const,
    queued: true as const,
    message: { role: "user", content: text },
  };
}

describe("follow-ups queued during a run (DER-621)", () => {
  it("keeps two sends queued during one run in the tray, in send order", () => {
    const container = renderChatView({
      messages: history,
      runId: activeRun,
      runActive: true,
      queue: [sent("message-2", "Message 2", 10), sent("message-3", "Message 3", 20)],
    });
    expect(transcriptUserTexts(container)).toEqual(["Message 1"]);
    expect(trayTexts(container)).toEqual(["Message 2", "Message 3"]);
  });

  it("does not show the later send as sent while the Gateway reports the earlier one queued", () => {
    // P5: Message 2 had reached the Gateway's queue; Message 3's ACK had not been reconciled.
    const historyState = makeChatHost({ currentSessionId: "p5-session" });
    applyChatPendingInputs(historyState, {
      total: 1,
      queuedCount: 1,
      items: [serverQueued("message-2", "Message 2", 10)],
    });
    const container = renderChatView({
      historyState,
      messages: history,
      runId: activeRun,
      runActive: true,
      queue: [sent("message-3", "Message 3", 20)],
    });
    expect(transcriptUserTexts(container)).toEqual(["Message 1"]);
    expect(trayTexts(container)).toEqual(["Message 2", "Message 3"]);
  });

  it("moves each send into the transcript only when its own turn starts, appended at the bottom", () => {
    const container = renderChatView({
      messages: history,
      runId: "run-message-2",
      runActive: true,
      queue: [sent("message-2", "Message 2", 10), sent("message-3", "Message 3", 20)],
    });
    expect(transcriptUserTexts(container)).toEqual(["Message 1", "Message 2"]);
    expect(trayTexts(container)).toEqual(["Message 3"]);
    expect(transcriptOrder(container)).toEqual([
      "user:Message 1",
      "assistant:Got Message 1",
      "user:Message 2",
    ]);
  });

  it("holds a later send while the Gateway has started an earlier one the client has not adopted", () => {
    const historyState = makeChatHost({ currentSessionId: "gap-session" });
    applyChatPendingInputs(historyState, {
      total: 1,
      items: [startedInput("message-2", "Message 2", 10)],
    });
    const container = renderChatView({
      historyState,
      messages: history,
      runId: null,
      queue: [sent("message-3", "Message 3", 20)],
    });
    expect(transcriptUserTexts(container)).toEqual(["Message 1", "Message 2"]);
    expect(trayTexts(container)).toEqual(["Message 3"]);
  });

  it("moves a held send from the tray to the bottom of the transcript when its run is adopted", () => {
    const container = document.createElement("div");
    const queue = [sent("message-2", "Message 2", 10), sent("message-3", "Message 3", 20)];
    renderChatInto(container, { messages: history, runId: activeRun, runActive: true, queue });
    expect(trayTexts(container)).toEqual(["Message 2", "Message 3"]);
    renderChatInto(container, {
      messages: history,
      runId: "run-message-2",
      runActive: true,
      queue,
    });
    expect(transcriptOrder(container)).toEqual([
      "user:Message 1",
      "assistant:Got Message 1",
      "user:Message 2",
    ]);
    expect(trayTexts(container)).toEqual(["Message 3"]);
  });

  it("never pulls a shown send back to the tray when a later run is adopted first", () => {
    const container = document.createElement("div");
    const queue = [sent("message-2", "Message 2", 10), sent("message-3", "Message 3", 20)];
    renderChatInto(container, {
      messages: history,
      runId: "run-message-2",
      runActive: true,
      queue,
    });
    expect(transcriptUserTexts(container)).toEqual(["Message 1", "Message 2"]);
    // Run 3 is adopted before Message 2's row has been retired by history.
    renderChatInto(container, {
      messages: history,
      runId: "run-message-3",
      runActive: true,
      queue,
    });
    expect(transcriptUserTexts(container)).toEqual(["Message 1", "Message 2", "Message 3"]);
    expect(trayTexts(container)).toEqual([]);
  });

  it("keeps a shown bubble in place when its delivery is retried during another run", () => {
    const container = document.createElement("div");
    const interrupted: ChatQueueItem = {
      ...sent("message-2", "Message 2", 10),
      sendState: "waiting-reconnect",
    };
    renderChatInto(container, {
      messages: history,
      runId: activeRun,
      runActive: true,
      queue: [interrupted],
    });
    expect(transcriptUserTexts(container)).toEqual(["Message 1", "Message 2"]);
    // Reconnect resends it under a fresh run id while the first run continues.
    const retried: ChatQueueItem = {
      ...interrupted,
      sendState: "sending",
      sendAttempts: 2,
      sendRunId: "run-message-2-retry",
    };
    renderChatInto(container, {
      messages: history,
      runId: activeRun,
      runActive: true,
      queue: [retried],
    });
    expect(transcriptUserTexts(container)).toEqual(["Message 1", "Message 2"]);
    expect(trayTexts(container)).toEqual([]);
  });

  it("applies the turn rule again once a shown row is back in plain queued state", () => {
    const container = document.createElement("div");
    const unconfirmed: ChatQueueItem = {
      ...sent("message-2", "Message 2", 10),
      sendState: "unconfirmed",
    };
    const render = (item: ChatQueueItem) =>
      renderChatInto(container, {
        messages: history,
        runId: activeRun,
        runActive: true,
        queue: [item],
      });
    render(unconfirmed);
    expect(transcriptUserTexts(container)).toEqual(["Message 1", "Message 2"]);
    // Custody confirmation parks it as plain queued input, back in the tray.
    render({ ...unconfirmed, sendState: "waiting-idle", sendError: undefined });
    expect(trayTexts(container)).toEqual(["Message 2"]);
    // Sent again during another run, it waits for its own turn.
    render({ ...unconfirmed, sendState: "sending", sendRunId: "run-message-2-retry" });
    expect(transcriptUserTexts(container)).toEqual(["Message 1"]);
    expect(trayTexts(container)).toEqual(["Message 2"]);
  });

  it("lets only the next turn enter the transcript between runs", () => {
    const container = renderChatView({
      messages: history,
      runId: null,
      queue: [sent("message-2", "Message 2", 10), sent("message-3", "Message 3", 20)],
    });
    expect(transcriptUserTexts(container)).toEqual(["Message 1", "Message 2"]);
    expect(trayTexts(container)).toEqual(["Message 3"]);
  });

  it("still shows an idle send in the transcript at once", () => {
    const container = renderChatView({
      messages: history,
      runId: null,
      queue: [sent("message-2", "Message 2", 10)],
    });
    expect(transcriptUserTexts(container)).toEqual(["Message 1", "Message 2"]);
    expect(trayTexts(container)).toEqual([]);
  });

  it("offers no local discard for a send the Gateway already holds", () => {
    const container = renderChatView({
      messages: history,
      runId: activeRun,
      runActive: true,
      queue: [sent("message-2", "Message 2", 10)],
    });
    expect(trayTexts(container)).toEqual(["Message 2"]);
    expect(container.querySelector(".chat-queue__remove")).toBeNull();
  });
});
