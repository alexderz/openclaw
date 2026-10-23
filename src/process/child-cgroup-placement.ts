import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { parseBooleanValue } from "../utils/boolean.js";

/**
 * Under systemd `Delegate=yes` + `DelegateSubgroup=main`, the Gateway starts in
 * `<unit>/main/` and owns the unit's cgroup subtree. Moving every child the
 * Gateway starts into the sibling `<unit>/children/` leaves `main/` holding only
 * the Gateway, so `main/memory.low` protects the Gateway alone.
 *
 * Inert unless the Gateway enables it and delegation is detected. Never throws
 * and never moves the Gateway. Opt out with `OPENCLAW_CHILD_CGROUP=off`.
 */

const DISABLE_ENV_KEY = "OPENCLAW_CHILD_CGROUP";
const SUBGROUP_ENV_KEY = "OPENCLAW_CHILD_CGROUP_SUBGROUP";
const MEMORY_LOW_ENV_KEY = "OPENCLAW_GATEWAY_MEMORY_LOW";
const DEFAULT_SUBGROUP = "main";
const CHILDREN_SUBGROUP = "children";
const SWEEP_INTERVAL_MS = 15_000;
const MAX_ANCESTRY_DEPTH = 64;
const MEMORY_LOW_VALUE = /^(?:\d+[KMG]?|max)$/i;
const CGROUP_NAME = /^[A-Za-z0-9_.@:-]+$/;

type PlacementLog = { info: (message: string) => void; warn: (message: string) => void };

export type ChildCgroupPlacementOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Gateway pid; never moved. */
  pid?: number;
  procRoot?: string;
  cgroupRoot?: string;
  log?: PlacementLog;
};

export type ChildCgroupPlacement = {
  readonly active: boolean;
  readonly reason: string;
  readonly childrenDir?: string;
  /** Move one pid into `children/`; false when inactive, the Gateway, or the write failed. */
  place: (pid: number | undefined) => boolean;
  /** Move the Gateway's descendants still in `main/`; returns how many moved. */
  sweep: () => number;
};

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
}

function inactive(reason: string): ChildCgroupPlacement {
  return { active: false, reason, place: () => false, sweep: () => 0 };
}

function readV2CgroupPath(procRoot: string): string | undefined {
  const content = fs.readFileSync(path.join(procRoot, "self", "cgroup"), "utf8");
  for (const line of content.split("\n")) {
    if (line.startsWith("0::")) {
      return line.slice(3).trim();
    }
  }
  return undefined;
}

function readParentPid(procRoot: string, pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    // comm may contain spaces and parentheses; fields resume after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/** Enable +memory below the unit and write main/memory.low when the operator configured one. */
function applyMemoryLow(params: {
  value: string | undefined;
  parentDir: string;
  mainDir: string;
  log: PlacementLog;
}): void {
  const value = params.value?.trim();
  if (!value) {
    return;
  }
  if (!MEMORY_LOW_VALUE.test(value)) {
    params.log.warn(`${MEMORY_LOW_ENV_KEY}=${value} is not bytes[K|M|G] or max; not applied`);
    return;
  }
  try {
    const enabled = fs.readFileSync(path.join(params.parentDir, "cgroup.subtree_control"), "utf8");
    if (!enabled.split(/\s+/).includes("memory")) {
      fs.writeFileSync(path.join(params.parentDir, "cgroup.subtree_control"), "+memory");
    }
    fs.writeFileSync(path.join(params.mainDir, "memory.low"), value);
    params.log.info(`gateway memory.low=${value} set on ${params.mainDir}`);
  } catch (error) {
    params.log.warn(`gateway memory.low not applied (${errorCode(error)})`);
  }
}

export function createChildCgroupPlacement(
  options: ChildCgroupPlacementOptions = {},
): ChildCgroupPlacement {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const procRoot = options.procRoot ?? "/proc";
  const cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
  const selfPid = options.pid ?? process.pid;
  const log = options.log ?? createSubsystemLogger("process/cgroup");
  if (platform !== "linux") {
    return inactive("not linux");
  }
  if (parseBooleanValue(env[DISABLE_ENV_KEY]) === false) {
    return inactive(`${DISABLE_ENV_KEY} disabled`);
  }
  const subgroup = env[SUBGROUP_ENV_KEY]?.trim() || DEFAULT_SUBGROUP;
  if (!CGROUP_NAME.test(subgroup) || subgroup === CHILDREN_SUBGROUP) {
    return inactive(`invalid ${SUBGROUP_ENV_KEY}`);
  }
  let parentDir: string;
  let mainDir: string;
  let childrenDir: string;
  try {
    const current = readV2CgroupPath(procRoot);
    if (current === undefined) {
      return inactive("no cgroup v2 membership");
    }
    if (path.posix.basename(current) !== subgroup || path.posix.dirname(current) === "/") {
      return inactive(`cgroup leaf is not delegated subgroup "${subgroup}"`);
    }
    mainDir = path.join(cgroupRoot, current);
    parentDir = path.dirname(mainDir);
    childrenDir = path.join(parentDir, CHILDREN_SUBGROUP);
  } catch (error) {
    return inactive(`cgroup membership unreadable (${errorCode(error)})`);
  }
  try {
    // Under Delegate=yes the unit's subtree belongs to us; without it these fail.
    fs.accessSync(parentDir, fs.constants.W_OK);
    fs.accessSync(path.join(parentDir, "cgroup.procs"), fs.constants.W_OK);
    try {
      fs.mkdirSync(childrenDir);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  } catch (error) {
    const reason = `delegated cgroup not writable (${errorCode(error)})`;
    log.warn(`child cgroup placement inactive: ${reason} at ${parentDir}`);
    return inactive(reason);
  }
  const childrenProcs = path.join(childrenDir, "cgroup.procs");
  let warned = false;
  const place = (pid: number | undefined): boolean => {
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || pid === selfPid) {
      return false;
    }
    try {
      fs.writeFileSync(childrenProcs, String(pid));
      return true;
    } catch (error) {
      // A child that already exited is not a placement failure.
      if (errorCode(error) !== "ESRCH" && !warned) {
        warned = true;
        log.warn(`child cgroup placement failed for pid ${pid} (${errorCode(error)})`);
      }
      return false;
    }
  };
  const isDescendant = (pid: number): boolean => {
    let current: number | undefined = pid;
    for (let depth = 0; current !== undefined && depth < MAX_ANCESTRY_DEPTH; depth += 1) {
      current = readParentPid(procRoot, current);
      if (current === selfPid) {
        return true;
      }
    }
    return false;
  };
  const sweep = (): number => {
    let pids: number[];
    try {
      pids = fs
        .readFileSync(path.join(mainDir, "cgroup.procs"), "utf8")
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== selfPid);
    } catch {
      return 0;
    }
    // Only our descendants: an ancestor launcher or foreign process stays put.
    return pids.filter((pid) => isDescendant(pid) && place(pid)).length;
  };
  applyMemoryLow({ value: env[MEMORY_LOW_ENV_KEY], parentDir, mainDir, log });
  log.info(`child cgroup placement active: children=${childrenDir}`);
  return { active: true, reason: "delegated", childrenDir, place, sweep };
}

type PlacementState = { placement?: ChildCgroupPlacement; timer?: NodeJS.Timeout };

function resetState(value: PlacementState): void {
  clearInterval(value.timer);
  value.timer = undefined;
  value.placement = undefined;
}

// Shared across duplicated runtime chunks so plugin SDK callers see the Gateway's state.
const state = resolveGlobalSingleton<PlacementState>(
  Symbol.for("openclaw.childCgroupPlacement"),
  () => ({}),
  resetState,
  "close-only",
);

/** Gateway startup only: detect delegation once, move earlier children, start the backstop sweep. */
export function enableGatewayChildCgroupPlacement(
  options?: ChildCgroupPlacementOptions,
): ChildCgroupPlacement {
  if (state.placement) {
    return state.placement;
  }
  try {
    state.placement = createChildCgroupPlacement(options);
  } catch {
    state.placement = inactive("detection failed");
  }
  const placement = state.placement;
  if (placement.active) {
    placement.sweep();
    state.timer = setInterval(() => placement.sweep(), SWEEP_INTERVAL_MS);
    state.timer.unref();
  }
  return placement;
}

/** Move a just-spawned native child out of the Gateway's protected cgroup; no-op when inactive. */
export function placeChildInChildCgroup(
  child: Pick<ChildProcess, "pid" | "once"> | undefined,
): void {
  const placement = state.placement;
  if (!placement?.active || !child) {
    return;
  }
  try {
    if (child.pid !== undefined) {
      placement.place(child.pid);
    } else {
      child.once("spawn", () => placement.place(child.pid));
    }
  } catch {
    // Placement is best effort and must never affect spawn.
  }
}

export function resetChildCgroupPlacementForTest(): void {
  resetState(state);
}
