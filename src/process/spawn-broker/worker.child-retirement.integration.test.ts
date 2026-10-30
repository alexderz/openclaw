import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createSpawnBrokerHost } from "./host.js";
import type { BrokerChild } from "./child.js";

type Snapshot = { id: number; pid?: number; announced: boolean; exited: boolean; disconnected: boolean; resultSettled: boolean; openPipes: number[] };
type Frame = { type: string; id?: number; fd?: number };
type HostInternals = { transmit: (...args: [Frame, ...unknown[]]) => Promise<void>; requests: Map<number, unknown> };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

it("reconciles native exit/IPC and actual execa output/result receipts before retiring worker custody", async () => {
  const directory = mkdtempSync(join(tmpdir(), "broker-custody-test-"));
  const snapshotPath = join(directory, "snapshot.json");
  const previous = process.env.OPENCLAW_TEST_BROKER_SNAPSHOT;
  process.env.OPENCLAW_TEST_BROKER_SNAPSHOT = snapshotPath;
  const host = createSpawnBrokerHost({ nativeResources: true, workerUrl: new URL("./worker.child-retirement.observer.ts", import.meta.url) });
  if (previous === undefined) delete process.env.OPENCLAW_TEST_BROKER_SNAPSHOT;
  else process.env.OPENCLAW_TEST_BROKER_SNAPSHOT = previous;
  const internal = host as unknown as HostInternals;
  const original = internal.transmit;
  const pending = new Map<string, { release: () => void; seen: Promise<void> }>();
  let activeId = -1;
  let phase = "startup";
  const deadline = Date.now() + 20_000;
  const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    phase = label;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Scenario deadline: ${label}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Scenario deadline: ${label}`)), remaining); })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  for (const kind of ["pipe-received", "output-drained"]) {
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen = new Promise<void>((resolve) => { signal = resolve; });
    pending.set(kind, { release, seen });
    Object.assign(pending.get(kind)!, { gate, signal });
  }
  type Gate = { release: () => void; seen: Promise<void>; gate: Promise<void>; signal: () => void };
  internal.transmit = async (...args) => {
    const frame = args[0];
    if (frame.id === activeId && frame.fd === 1 && pending.has(frame.type)) {
      const gate = pending.get(frame.type)! as Gate;
      gate.signal();
      await gate.gate;
    }
    return original.apply(host, args);
  };
  const brokerPid = host.pid!;
  const snapshot = async (): Promise<Snapshot[]> => {
    try { unlinkSync(snapshotPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    process.kill(brokerPid, "SIGUSR2");
    for (;;) {
      try { return JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot[]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await bounded(delay(10), "snapshot file notification");
    }
  };
  const observe = async (id: number, predicate: (entry: Snapshot | undefined) => boolean, label: string) => {
    let last: Snapshot | undefined;
    for (let probe = 0; probe < 20; probe++) {
      last = (await bounded(snapshot(), label)).find((entry) => entry.id === id);
      if (predicate(last)) return last;
      await bounded(delay(100), label);
    }
    throw new Error(`${label}: last snapshot ${JSON.stringify(last)}`);
  };
  const runLeg = async (mode: "ipc" | "execa") => {
    const nonce = `custody-${mode}-${process.pid}`;
    const fixture = fileURLToPath(new URL("./worker.child-retirement.fixture.cjs", import.meta.url));
    const run = mode === "execa" ? host.spawnExeca([process.execPath, fixture, mode, nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", buffer: true, encoding: "utf8", reject: false, maxBuffer: 65536, stripFinalNewline: false }) : undefined;
    const child: BrokerChild = run?.child ?? host.spawn(process.execPath, [fixture, mode, nonce], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    activeId = child.requestId;
    let resultObserved = false;
    if (run) void run.result.then(() => { resultObserved = true; }, () => { resultObserved = true; });
    const messages: unknown[] = [], errors: Error[] = [];
    let exits = 0, closes = 0;
    child.on("message", (message: unknown) => messages.push(message));
    child.on("error", (error: Error) => errors.push(error));
    child.on("exit", () => { exits++; });
    child.on("close", () => { closes++; });
    await bounded(pending.get("pipe-received")!.seen, `${mode}: pipe-received held`);
    const before = await observe(activeId, (entry) => !!entry?.exited && entry.disconnected, `${mode}: native exit and disconnect`);
    expect(before?.announced).toBe(false);
    expect(before?.pid).toBeGreaterThan(0);
    pending.get("pipe-received")!.release();
    await bounded(child.ready(), `${mode}: child ready`);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    await bounded(pending.get("output-drained")!.seen, `${mode}: output-drained held`);
    const held = await observe(activeId, (entry) => !!entry?.announced && entry.exited && entry.disconnected && entry.openPipes.includes(1), `${mode}: held drain`);
    expect(held).toBeDefined();
    if (run) console.info(`execa held-drain resultSettled=${held!.resultSettled} hostResultObserved=${resultObserved}`);
    pending.get("output-drained")!.release();
    const result = run ? await bounded(run.result, `${mode}: execa result`) : undefined;
    await bounded(child.waitForClose(), `${mode}: child close`);
    await observe(activeId, (entry) => !entry, `${mode}: worker retired`);
    for (let probe = 0; internal.requests.has(activeId) && probe < 20; probe++) await bounded(delay(20), `${mode}: host retirement`);
    expect(internal.requests.has(activeId)).toBe(false);
    expect(Buffer.concat(stdout).toString()).toBe("O".repeat(4096) + `<OUT:${nonce}>`);
    expect(Buffer.concat(stderr).toString()).toBe("E".repeat(4096) + `<ERR:${nonce}>`);
    expect(errors).toEqual([]);
    expect(exits).toBe(1); expect(closes).toBe(1);
    if (mode === "ipc") expect(messages).toEqual([{ nonce }]);
    else {
      expect(result).toMatchObject({ exitCode: 0, failed: false, stdout: "O".repeat(4096) + `<OUT:${nonce}>`, stderr: "E".repeat(4096) + `<ERR:${nonce}>` });
      expect(messages).toEqual([]);
    }
    expect(() => process.kill(before!.pid!, 0)).toThrow();
  };
  try {
    await bounded(host.ready(), "broker ready");
    await runLeg("ipc");
    for (const kind of ["pipe-received", "output-drained"]) {
      let release!: () => void, signal!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const seen = new Promise<void>((resolve) => { signal = resolve; });
      pending.set(kind, { release, seen, gate, signal } as Gate);
    }
    await runLeg("execa");
  } finally {
    for (const gate of pending.values()) gate.release();
    internal.transmit = original;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([host.close().then(() => host.waitForCleanup()), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Teardown deadline after ${phase}`)), 5000); })]);
      expect(() => process.kill(brokerPid, 0)).toThrow();
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      // Only the fixture broker's own detached process group is eligible for emergency cleanup.
      try { process.kill(-brokerPid, "SIGKILL"); } catch {}
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}, 26000);
