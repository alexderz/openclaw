// Page cache and memory-mapped reads for retained WAL connections on local disks.
// SQLite's default 2 MiB cache per connection made large transcript reads and
// history sorts spill to temp files. Mapped pages live in the shared OS page
// cache: every connection to one file reuses them, and the kernel reclaims them
// under pressure instead of swapping them. Network and rollback-journal volumes
// never reach this path. temp_store stays FILE so big sorts cannot grow the heap.
import type { DatabaseSync } from "node:sqlite";

// cache_size is anonymous heap per connection, and a busy gateway retains
// dozens of them, so the worst case is that many times this budget. With mmap reads most clean pages bypass it; it
// mostly bounds dirty pages and how much a sort keeps in memory before spilling.
export const DEFAULT_SQLITE_CACHE_KIB = 8 * 1024;
// Set OPENCLAW_SQLITE_MMAP_BYTES=0 to turn mapped reads off without a rebuild.
export const DEFAULT_SQLITE_MMAP_BYTES = 512 * 1024 * 1024;

const CACHE_KIB_ENV = "OPENCLAW_SQLITE_CACHE_KIB";
const MMAP_BYTES_ENV = "OPENCLAW_SQLITE_MMAP_BYTES";
// Upper bounds keep a mistyped override from asking for absurd budgets.
const MAX_CACHE_KIB = 1024 * 1024;
const MAX_MMAP_BYTES = 8 * 1024 * 1024 * 1024;

function readBudget(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return fallback;
  }
  return Math.min(Number(raw), maximum);
}

export type SqliteLocalCacheBudget = { cacheKib: number; mmapBytes: number };

export function resolveSqliteLocalCacheBudget(
  env: NodeJS.ProcessEnv = process.env,
): SqliteLocalCacheBudget {
  return {
    cacheKib: readBudget(env, CACHE_KIB_ENV, DEFAULT_SQLITE_CACHE_KIB, MAX_CACHE_KIB),
    mmapBytes: readBudget(env, MMAP_BYTES_ENV, DEFAULT_SQLITE_MMAP_BYTES, MAX_MMAP_BYTES),
  };
}

/**
 * Apply the cache budget to one connection. A zero value keeps SQLite's own
 * default for that pragma. SQLite caps mmap_size at its compile-time maximum.
 */
export function configureSqliteLocalCachePragmas(
  db: DatabaseSync,
  budget: SqliteLocalCacheBudget = resolveSqliteLocalCacheBudget(),
): void {
  if (budget.cacheKib > 0) {
    // Negative cache_size is a connection-local KiB budget.
    db.exec(`PRAGMA cache_size = -${budget.cacheKib};`); // sqlite-allow-raw -- Retained connection cache policy.
  }
  if (budget.mmapBytes > 0) {
    db.exec(`PRAGMA mmap_size = ${budget.mmapBytes};`); // sqlite-allow-raw -- Retained connection mapped-read policy.
  }
}
