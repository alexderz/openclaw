import { describe, expect, it, vi } from "vitest";
import { beginSessionWorkAdmission } from "./session-lifecycle-admission.js";
import { notifySessionWorkSettled, onSessionWorkSettled } from "./session-work-settlement.js";

describe("session work settlement notifications", () => {
  it("defers delivery out of the owner's critical section and dedupes identities", async () => {
    const listener = vi.fn();
    const stop = onSessionWorkSettled(listener);
    notifySessionWorkSettled(["a", undefined, "a", "b"]);
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith(["a", "b"]);
    stop();
    notifySessionWorkSettled(["a"]);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
  });
  it("isolates a failing listener from the releasing owner and other listeners", async () => {
    const good = vi.fn();
    const stopBad = onSessionWorkSettled(() => {
      throw new Error("listener failure");
    });
    const stopGood = onSessionWorkSettled(good);
    expect(() => notifySessionWorkSettled(["a"])).not.toThrow();
    await Promise.resolve();
    expect(good).toHaveBeenCalled();
    stopBad();
    stopGood();
  });
  it("announces the raw identities when a session work lease is released", async () => {
    const listener = vi.fn();
    const stop = onSessionWorkSettled(listener);
    const lease = await beginSessionWorkAdmission({
      scope: "/test/settlement-store",
      identities: ["agent:main:dashboard:t", "session-t"],
      assertAllowed: () => {},
    });
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    lease.release();
    lease.release();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(["agent:main:dashboard:t", "session-t"]);
    stop();
  });
});
