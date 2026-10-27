import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  markSqliteHoldResources,
  measureSqliteHoldResources,
  testing as holdResourcesTesting,
} from "./sqlite-hold-resources.js";
import { describeSqliteWorkerOperation } from "./sqlite-operation-label.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];

function createDatabase(): import("node:sqlite").DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY)");
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  holdResourcesTesting.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("slow SQLite hold resources", () => {
  it("reports thread CPU and major faults with the hold, then GC pauses inside it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const logger = { warn: vi.fn() };
    let now = 0;
    let monotonic = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const db = createDatabase();

    runSqliteImmediateTransactionSync(
      db,
      () => {
        db.prepare("INSERT INTO entries VALUES ('a')").run();
        now += 2_000;
        monotonic += 2_000;
      },
      { logger, operationLabel: "session.write" },
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "slow SQLite transaction hold",
      expect.objectContaining({
        operation: "session.write",
        elapsedMs: 2_000,
        resources: {
          threadCpuMs: expect.any(Number),
          majorPageFaults: expect.any(Number),
        },
      }),
    );

    // One pause inside the hold, one partly inside, one after it ended.
    holdResourcesTesting.recordGcEntry({ startTime: 1_500, duration: 300 });
    holdResourcesTesting.recordGcEntry({ startTime: 2_900, duration: 200 });
    holdResourcesTesting.recordGcEntry({ startTime: 3_100, duration: 400 });
    vi.advanceTimersByTime(50);

    expect(logger.warn).toHaveBeenLastCalledWith("slow SQLite transaction hold gc", {
      database: ":memory:",
      operation: "session.write",
      elapsedMs: 2_000,
      gcCount: 2,
      gcMs: 400,
      gcMaxMs: 300,
      isMainThread,
      pid: process.pid,
      threadId,
    });
  });

  it("does not schedule a GC report for a fast hold", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const logger = { warn: vi.fn() };
    runSqliteImmediateTransactionSync(createDatabase(), () => undefined, { logger });
    vi.advanceTimersByTime(100);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("SQLite hold resource counters", () => {
  it("reads real thread CPU and fault counters", () => {
    const mark = markSqliteHoldResources();
    expect(mark).toBeDefined();
    let spin = 0;
    for (let index = 0; index < 200_000; index += 1) {
      spin += index % 7;
    }
    expect(spin).toBeGreaterThan(0);
    const usage = measureSqliteHoldResources(mark!);
    expect(usage?.threadCpuMs).toBeGreaterThanOrEqual(0);
    expect(usage?.majorPageFaults).toBeGreaterThanOrEqual(0);
  });
});

describe("worker operation labels", () => {
  it("names the inner command of a publication envelope", () => {
    expect(
      describeSqliteWorkerOperation({
        type: "database.domain.execute",
        input: { id: "p1", command: { type: "authProfiles.usage", input: { secret: "x" } } },
      }),
    ).toBe("database.domain.execute:authProfiles.usage");
    expect(
      describeSqliteWorkerOperation({
        type: "database.domain.publish",
        input: { id: "p1", moduleUrl: "file:///m.js", command: { type: "catalog.replace" } },
      }),
    ).toBe("database.domain.publish:catalog.replace");
  });

  it("keeps the plain type for other commands and malformed envelopes", () => {
    expect(describeSqliteWorkerOperation({ type: "session.turn.commit", input: {} })).toBe(
      "session.turn.commit",
    );
    expect(describeSqliteWorkerOperation({ type: "database.domain.execute" })).toBe(
      "database.domain.execute",
    );
    expect(
      describeSqliteWorkerOperation({ type: "database.domain.execute", input: { command: {} } }),
    ).toBe("database.domain.execute");
  });
});
