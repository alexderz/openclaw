import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  readSessionMessageIdentity,
  reduceSessionProjection,
} from "./session-projection.js";

const row = (id: string, seq: number) => ({
  role: "assistant",
  content: [{ type: "text", text: `reply ${seq}` }],
  __openclaw: { id, seq },
});

describe("snapshot authority over settled live copies", () => {
  it("drops an unmatched settled live copy inside the listed range only", () => {
    const snapshot = [row("a", 1), row("b", 2)];
    let state = reduceSessionProjection(createSessionProjection({}), {
      type: "snapshotLoaded",
      messages: snapshot,
    });
    for (const live of [row("stale", 2), row("newer", 3)]) {
      state = reduceSessionProjection(state, { type: "messagePersisted", message: live });
    }
    const ids = (next: typeof state) =>
      next.messages.map((message) => readSessionMessageIdentity(message)?.id);
    expect(
      ids(reduceSessionProjection(state, { type: "snapshotLoaded", messages: snapshot })),
    ).toEqual(["a", "b", "stale", "newer"]);
    expect(
      ids(
        reduceSessionProjection(state, {
          type: "snapshotLoaded",
          messages: snapshot,
          options: { authoritativeSequences: { from: 1, to: 2 } },
        }),
      ),
    ).toEqual(["a", "b", "newer"]);
  });
});
