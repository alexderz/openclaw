import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { BrokerRequest, BrokerResponse } from "./protocol.js";
import type { BrokerBootstrap } from "./resource-protocol.js";

const boundary = vi.hoisted(() => ({
  start: vi.fn(),
  send: vi.fn(),
}));
vi.mock("./execa-worker.js", () => ({ startBrokerExeca: boundary.start }));
vi.mock("./pipe.js", () => ({
  holdPipeForTransfer: vi.fn(),
  takePipePrefix: () => Buffer.alloc(0),
}));
vi.mock("./worker-sender.js", () => ({
  createWorkerSender: () => ({
    send: boundary.send,
    reserve: (run: (publish: typeof boundary.send) => Promise<unknown>) => run(boundary.send),
    acknowledge: vi.fn(),
    close: vi.fn(),
  }),
}));

it.each([false, true])(
  "joins native exit, result and pipe receipts without aggregate close (live error=%s)",
  async (liveError) => {
    vi.resetModules();
    vi.resetAllMocks();
    boundary.send.mockResolvedValue(undefined);
    let receive: ((message: BrokerBootstrap | BrokerRequest) => void) | undefined;
    const connected = Object.getOwnPropertyDescriptor(process, "connected");
    const originalOn = process.on.bind(process);
    const originalOnce = process.once.bind(process);
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "message") {
        receive = listener;
        return process;
      }
      if (event === "SIGTERM" || event === "SIGINT") {
        return process;
      }
      return originalOn(event, listener);
    });
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "disconnect") {
        return process;
      }
      return originalOnce(event, listener);
    });
    Object.defineProperty(process, "connected", { configurable: true, value: true });
    const socket = new Socket();
    const child = Object.assign(new EventEmitter(), {
      pid: 41001,
      connected: true,
      stdio: [null, socket, null],
      spawnfile: "fixture",
      spawnargs: ["fixture"],
      kill: vi.fn(),
    });
    let settleResult!: (value: object) => void;
    const result = new Promise<object>((resolve) => {
      settleResult = resolve;
    });
    const kill = vi.fn();
    const drained = vi.fn();
    boundary.start.mockResolvedValue({
      child,
      stdio: child.stdio,
      result,
      kill,
      cancel: vi.fn(),
      outputDrained: drained,
    });
    try {
      await import("./worker.js");
      if (!receive) throw new Error("worker message entrypoint missing");
      receive({ type: "bootstrap" });
      await setImmediate();
      receive({ type: "spawn-execa", id: 7, argv: ["fixture"], options: {} });
      await setImmediate();
      expect(
        boundary.send.mock.calls.map(([message]) => (message as BrokerResponse).type),
      ).toContain("spawned");
      if (liveError) {
        child.emit("error", new Error("live PID signal error"));
        receive({ type: "kill", id: 7, signal: "SIGTERM" });
        expect(kill).toHaveBeenCalledTimes(1);
      }
      child.emit("exit", 0, null);
      receive({ type: "kill", id: 7, signal: "SIGTERM" });
      expect(kill).toHaveBeenCalledTimes(liveError ? 2 : 1);
      settleResult({ failed: false });
      await setImmediate();
      receive({ type: "kill", id: 7, signal: "SIGTERM" });
      expect(kill).toHaveBeenCalledTimes(liveError ? 3 : 2);
      receive({ type: "output-drained", id: 7, fd: 1 });
      expect(drained).toHaveBeenCalledTimes(1);
      receive({ type: "kill", id: 7, signal: "SIGTERM" });
      expect(kill).toHaveBeenCalledTimes(liveError ? 4 : 3);
      child.emit("disconnect");
      receive({ type: "kill", id: 7, signal: "SIGTERM" });
      expect(kill).toHaveBeenCalledTimes(liveError ? 4 : 3);
      // No synthetic aggregate close is emitted at any point.
    } finally {
      socket.destroy();
      await setImmediate();
      if (connected) Object.defineProperty(process, "connected", connected);
      else Reflect.deleteProperty(process, "connected");
      vi.restoreAllMocks();
    }
  },
);
