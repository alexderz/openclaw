import { afterEach, describe, expect, it } from "vitest";
import {
  readTurnAuthorityClass,
  recordRunAuthorityClass,
  resetRunAuthorityTestState,
} from "./turn-authority.ts";

afterEach(() => {
  resetRunAuthorityTestState();
});

describe("readTurnAuthorityClass", () => {
  it("reads the transcript stamp of a user turn", () => {
    for (const authorityClass of ["delegated", "ordinary"] as const) {
      expect(
        readTurnAuthorityClass({ role: "user", content: "go", __openclaw: { authorityClass } }),
      ).toBe(authorityClass);
    }
  });

  it("never guesses for unstamped, malformed or non-user messages", () => {
    expect(readTurnAuthorityClass({ role: "user", content: "older turn" })).toBeUndefined();
    expect(
      readTurnAuthorityClass({ role: "user", __openclaw: { authorityClass: "admin" } }),
    ).toBeUndefined();
    expect(
      readTurnAuthorityClass({ role: "assistant", __openclaw: { authorityClass: "delegated" } }),
    ).toBeUndefined();
    expect(readTurnAuthorityClass(null)).toBeUndefined();
  });

  it("marks the local copy of a turn from its run's live chat event", () => {
    const local = { role: "user", content: "go", __openclaw: { idempotencyKey: "run-1:user" } };
    expect(readTurnAuthorityClass(local)).toBeUndefined();
    recordRunAuthorityClass("run-1", "delegated");
    expect(readTurnAuthorityClass(local)).toBe("delegated");
    // Another run's report says nothing about this turn.
    expect(
      readTurnAuthorityClass({ role: "user", __openclaw: { idempotencyKey: "run-2:user" } }),
    ).toBeUndefined();
  });

  it("prefers the transcript stamp over a live report", () => {
    recordRunAuthorityClass("run-1", "delegated");
    expect(
      readTurnAuthorityClass({
        role: "user",
        __openclaw: { idempotencyKey: "run-1:user", authorityClass: "ordinary" },
      }),
    ).toBe("ordinary");
  });

  it("ignores unknown classes and missing run ids", () => {
    recordRunAuthorityClass("run-1", "root");
    recordRunAuthorityClass(undefined, "delegated");
    expect(
      readTurnAuthorityClass({ role: "user", __openclaw: { idempotencyKey: "run-1:user" } }),
    ).toBeUndefined();
  });

  it("keeps the live table bounded, dropping the oldest run first", () => {
    for (let index = 0; index <= 256; index += 1) {
      recordRunAuthorityClass(`run-${index}`, "delegated");
    }
    const turn = (runId: string) => ({
      role: "user",
      __openclaw: { idempotencyKey: `${runId}:user` },
    });
    expect(readTurnAuthorityClass(turn("run-0"))).toBeUndefined();
    expect(readTurnAuthorityClass(turn("run-1"))).toBe("delegated");
    expect(readTurnAuthorityClass(turn("run-256"))).toBe("delegated");
  });
});
