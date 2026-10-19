import { EventEmitter } from "node:events";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

// Exercise the authoritative worker helper without starting the worker's IPC server.
const source = fs.readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
const start = source.indexOf("function waitForBrokerChildCompletion(");
const end = source.indexOf("async function launch(", start);
// 10.5 ships the native TypeScript 7 compiler, which has no JS transpile API.
const code = stripTypeScriptTypes(source.slice(start, end));
const waitForCompletion = new Function(code + "; return waitForBrokerChildCompletion;")() as (
  child: EventEmitter,
) => Promise<void>;
function child(connected = true, stdio: PassThrough[] | undefined = []) {
  return Object.assign(new EventEmitter(), {
    pid: 42 as number | undefined,
    connected,
    exitCode: null,
    signalCode: null,
    stdio: stdio as PassThrough[] | undefined,
  });
}

describe("spawn broker native retirement receipts", () => {
  it("joins exit and disconnect even without aggregate close", async () => {
    const native = child();
    let done = false;
    const completion = waitForCompletion(native).then(() => {
      done = true;
    });
    native.emit("disconnect");
    await Promise.resolve();
    expect(done).toBe(false);
    native.emit("exit", 0, null);
    await completion;
    expect(done).toBe(true);
    expect(native.listenerCount("error")).toBe(0);
  });
  it("retains open stdio after exit and ignores live-PID errors", async () => {
    const pipe = new PassThrough();
    const native = child(false, [pipe]);
    let done = false;
    const completion = waitForCompletion(native).then(() => {
      done = true;
    });
    native.emit("error", new Error("signal failed"));
    await Promise.resolve();
    expect(done).toBe(false);
    native.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(done).toBe(false);
    pipe.destroy();
    await completion;
    expect(done).toBe(true);
  });
  it.each(["EMFILE", "ENFILE"])(
    "preserves %s failed-spawn errors without stdio",
    async (errorCode) => {
      const native = child(false);
      native.pid = undefined;
      native.stdio = undefined;
      const originalError = Object.assign(new Error(errorCode), { code: errorCode });
      const completion = waitForCompletion(native);
      const errorReceipt = new Promise<Error>((resolve) => {
        native.once("error", resolve);
      });
      // Mirror launch: wait for native completion, then rethrow the original spawn error.
      const failedLaunch = Promise.all([completion, errorReceipt]).then(([, error]) => {
        throw error;
      });
      native.emit("error", originalError);
      await expect(failedLaunch).rejects.toBe(originalError);
      expect(native.listenerCount("exit")).toBe(0);
      expect(native.listenerCount("disconnect")).toBe(0);
      expect(native.listenerCount("error")).toBe(0);
    },
  );
  it("settles failed spawn without a native PID", async () => {
    const native = child(false);
    native.pid = undefined;
    const completion = waitForCompletion(native);
    native.emit("error", new Error("ENOENT"));
    await completion;
  });
});
