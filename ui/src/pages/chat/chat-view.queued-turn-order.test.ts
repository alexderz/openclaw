/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
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
