import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  DEFAULT_SQLITE_CACHE_KIB,
  DEFAULT_SQLITE_MMAP_BYTES,
  resolveSqliteLocalCacheBudget,
} from "./sqlite-cache-pragmas.js";
import { configureSqliteConnectionPragmas, type SqliteWalMaintenance } from "./sqlite-wal.js";

const cleanups: Array<() => void> = [];

beforeEach(() => {
  // Empty overrides fall back to the defaults these tests assert.
  vi.stubEnv("OPENCLAW_SQLITE_CACHE_KIB", "");
  vi.stubEnv("OPENCLAW_SQLITE_MMAP_BYTES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

function openConfigured(pathname: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  const maintenance: SqliteWalMaintenance = configureSqliteConnectionPragmas(db, {
    databasePath: pathname === ":memory:" ? undefined : pathname,
  });
  cleanups.push(() => {
    maintenance.close();
    db.close();
  });
  return db;
}

function readPragma(db: import("node:sqlite").DatabaseSync, name: string): unknown {
  return Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
}

describe("SQLite local cache pragmas", () => {
  it("uses the defaults and ignores malformed overrides", () => {
    const defaults = { cacheKib: DEFAULT_SQLITE_CACHE_KIB, mmapBytes: DEFAULT_SQLITE_MMAP_BYTES };
    expect(resolveSqliteLocalCacheBudget({})).toEqual(defaults);
    expect(
      resolveSqliteLocalCacheBudget({
        OPENCLAW_SQLITE_CACHE_KIB: "lots",
        OPENCLAW_SQLITE_MMAP_BYTES: "-1",
      }),
    ).toEqual(defaults);
  });

  it("accepts zero and caps oversized overrides", () => {
    expect(
      resolveSqliteLocalCacheBudget({
        OPENCLAW_SQLITE_CACHE_KIB: "0",
        OPENCLAW_SQLITE_MMAP_BYTES: " 0 ",
      }),
    ).toEqual({ cacheKib: 0, mmapBytes: 0 });
    expect(
      resolveSqliteLocalCacheBudget({
        OPENCLAW_SQLITE_CACHE_KIB: "999999999",
        OPENCLAW_SQLITE_MMAP_BYTES: "99999999999999",
      }),
    ).toEqual({ cacheKib: 1024 * 1024, mmapBytes: 8 * 1024 * 1024 * 1024 });
  });

  it("applies the budget to a retained WAL connection on a local file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-cache-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = openConfigured(path.join(dir, "state.sqlite"));
    expect(readPragma(db, "journal_mode")).toBe("wal");
    expect(readPragma(db, "cache_size")).toBe(-DEFAULT_SQLITE_CACHE_KIB);
    expect(readPragma(db, "mmap_size")).toBe(DEFAULT_SQLITE_MMAP_BYTES);
    expect(readPragma(db, "temp_store")).toBe(0);
  });

  it("leaves in-memory connections on SQLite defaults", () => {
    const db = openConfigured(":memory:");
    // SQLite reports no mmap_size row for an in-memory main database.
    expect(readPragma(db, "mmap_size")).toBeUndefined();
    expect(readPragma(db, "cache_size")).toBe(-2000);
  });
});
