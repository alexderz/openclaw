// Resource counters around a SQLite write hold. A slow hold whose SQL phase is
// mostly wall time can be JavaScript/GC work on this thread (CPU close to wall),
// swap-in (major faults), or descheduling (neither). Counters only, never data.
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";

export type SqliteHoldResourceMark = {
  readonly startedAt: number;
  readonly threadCpuUs: number;
  readonly majorPageFaults: number;
};

export type SqliteHoldResourceUsage = {
  threadCpuMs: number;
  majorPageFaults: number;
};

export type SqliteHoldGcUsage = { gcCount: number; gcMs: number; gcMaxMs: number };

const GC_ENTRY_LIMIT = 256;
const gcEntries: Array<{ start: number; end: number }> = [];
let gcObserver: PerformanceObserver | undefined;

function readThreadCpuUs(): number {
  const usage = process.threadCpuUsage();
  return usage.user + usage.system;
}

function ensureGcObserver(): void {
  if (gcObserver) {
    return;
  }
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcEntries.push({ start: entry.startTime, end: entry.startTime + entry.duration });
      }
      if (gcEntries.length > GC_ENTRY_LIMIT) {
        gcEntries.splice(0, gcEntries.length - GC_ENTRY_LIMIT);
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
    // Node 24's PerformanceObserver type and runtime have no unref. Keep the
    // optional call, with the observer as receiver, for a runtime that adds it.
    (gcObserver as PerformanceObserver & { unref?: () => void }).unref?.();
  } catch {
    // Diagnostics are optional; a runtime without GC entries reports none.
    gcObserver = undefined;
  }
}

/** Mark the start of a hold. Cheap: two counter syscalls and a clock read. */
export function markSqliteHoldResources(): SqliteHoldResourceMark | undefined {
  try {
    ensureGcObserver();
    return {
      startedAt: performance.now(),
      threadCpuUs: readThreadCpuUs(),
      majorPageFaults: process.resourceUsage().majorPageFault,
    };
  } catch {
    return undefined;
  }
}

/** Counters since the mark: this thread's CPU and the process's major faults. */
export function measureSqliteHoldResources(
  mark: SqliteHoldResourceMark,
): SqliteHoldResourceUsage | undefined {
  try {
    return {
      threadCpuMs: Math.round((readThreadCpuUs() - mark.threadCpuUs) / 1000),
      majorPageFaults: process.resourceUsage().majorPageFault - mark.majorPageFaults,
    };
  } catch {
    return undefined;
  }
}

/**
 * GC pauses on this thread that overlapped [mark, end]. GC entries arrive
 * asynchronously, so read this from a later macrotask, not inside the hold.
 */
export function readSqliteHoldGcUsage(
  mark: SqliteHoldResourceMark,
  endedAt: number,
): SqliteHoldGcUsage {
  let gcCount = 0;
  let gcMs = 0;
  let gcMaxMs = 0;
  for (const entry of gcEntries) {
    const overlap = Math.min(entry.end, endedAt) - Math.max(entry.start, mark.startedAt);
    if (overlap > 0) {
      gcCount += 1;
      gcMs += overlap;
      gcMaxMs = Math.max(gcMaxMs, overlap);
    }
  }
  return { gcCount, gcMs: Math.round(gcMs), gcMaxMs: Math.round(gcMaxMs) };
}

export const testing = {
  recordGcEntry(entry: Pick<PerformanceEntry, "startTime" | "duration">) {
    gcEntries.push({ start: entry.startTime, end: entry.startTime + entry.duration });
  },
  reset() {
    gcEntries.length = 0;
  },
};
