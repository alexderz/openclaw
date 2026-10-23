// Child cgroup placement tests use a fake /proc and a temp dir standing in for cgroupfs.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChildCgroupPlacement,
  enableGatewayChildCgroupPlacement,
  placeChildInChildCgroup,
  resetChildCgroupPlacementForTest,
  type ChildCgroupPlacementOptions,
} from "./child-cgroup-placement.js";

const UNIT = "/user.slice/user-963.slice/user@963.service/app.slice/openclaw-gateway.service";
const GATEWAY_PID = 2163;

let root: string;
let procRoot: string;
let cgroupRoot: string;
let unitDir: string;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function writeSelfCgroup(cgroupPath: string): void {
  fs.mkdirSync(path.join(procRoot, "self"), { recursive: true });
  fs.writeFileSync(path.join(procRoot, "self", "cgroup"), `0::${cgroupPath}\n`);
}

function writeProcStat(pid: number, ppid: number, comm = "node"): void {
  fs.mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(procRoot, String(pid), "stat"), `${pid} (${comm}) S ${ppid} 1 1 0\n`);
}

function makeDelegatedUnit(): void {
  fs.mkdirSync(path.join(unitDir, "main"), { recursive: true });
  fs.writeFileSync(path.join(unitDir, "cgroup.procs"), "");
  fs.writeFileSync(path.join(unitDir, "cgroup.subtree_control"), "cpu pids\n");
  fs.writeFileSync(path.join(unitDir, "main", "cgroup.procs"), `${GATEWAY_PID}\n`);
  writeSelfCgroup(`${UNIT}/main`);
}

function options(
  overrides: Partial<ChildCgroupPlacementOptions> = {},
): ChildCgroupPlacementOptions {
  return { platform: "linux", env: {}, pid: GATEWAY_PID, procRoot, cgroupRoot, log, ...overrides };
}

function childrenProcs(): string {
  return fs.readFileSync(path.join(unitDir, "children", "cgroup.procs"), "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-child-cgroup-"));
  procRoot = path.join(root, "proc");
  cgroupRoot = path.join(root, "cgroup");
  unitDir = path.join(cgroupRoot, UNIT);
  log = { info: vi.fn(), warn: vi.fn() };
});

afterEach(() => {
  resetChildCgroupPlacementForTest();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createChildCgroupPlacement", () => {
  it("creates children/ under a delegated unit and writes child pids there", () => {
    makeDelegatedUnit();
    const placement = createChildCgroupPlacement(options());
    expect(placement.active).toBe(true);
    expect(placement.childrenDir).toBe(path.join(unitDir, "children"));
    expect(fs.statSync(path.join(unitDir, "children")).isDirectory()).toBe(true);
    // A real cgroupfs creates cgroup.procs on mkdir; the temp dir needs it written.
    expect(placement.place(4242)).toBe(true);
    expect(childrenProcs()).toBe("4242");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("placement active"));
  });

  it("reuses an existing children/ directory", () => {
    makeDelegatedUnit();
    fs.mkdirSync(path.join(unitDir, "children"));
    fs.writeFileSync(path.join(unitDir, "children", "cgroup.procs"), "");
    expect(createChildCgroupPlacement(options()).active).toBe(true);
  });

  it("never moves the Gateway itself", () => {
    makeDelegatedUnit();
    const placement = createChildCgroupPlacement(options());
    expect(placement.place(GATEWAY_PID)).toBe(false);
    expect(placement.place(undefined)).toBe(false);
  });

  it("is a no-op when the cgroup is not the delegated subgroup", () => {
    fs.mkdirSync(unitDir, { recursive: true });
    writeSelfCgroup(UNIT);
    const placement = createChildCgroupPlacement(options());
    expect(placement.active).toBe(false);
    expect(placement.place(4242)).toBe(false);
    expect(fs.existsSync(path.join(unitDir, "children"))).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("is a no-op off Linux, without cgroup v2, and when disabled by env", () => {
    makeDelegatedUnit();
    expect(createChildCgroupPlacement(options({ platform: "darwin" })).active).toBe(false);
    expect(
      createChildCgroupPlacement(options({ env: { OPENCLAW_CHILD_CGROUP: "off" } })).active,
    ).toBe(false);
    fs.writeFileSync(path.join(procRoot, "self", "cgroup"), "1:name=systemd:/x\n");
    expect(createChildCgroupPlacement(options()).reason).toBe("no cgroup v2 membership");
    expect(fs.existsSync(path.join(unitDir, "children"))).toBe(false);
  });

  it("honours a configured subgroup name", () => {
    makeDelegatedUnit();
    expect(
      createChildCgroupPlacement(options({ env: { OPENCLAW_CHILD_CGROUP_SUBGROUP: "gateway" } }))
        .active,
    ).toBe(false);
    fs.mkdirSync(path.join(unitDir, "gateway"));
    writeSelfCgroup(`${UNIT}/gateway`);
    expect(
      createChildCgroupPlacement(options({ env: { OPENCLAW_CHILD_CGROUP_SUBGROUP: "gateway" } }))
        .active,
    ).toBe(true);
  });

  it("stays inactive and warns once when the unit cgroup is not ours", () => {
    makeDelegatedUnit();
    fs.rmSync(path.join(unitDir, "cgroup.procs"));
    const placement = createChildCgroupPlacement(options());
    expect(placement.active).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the subgroup's parent is not a systemd unit", () => {
    // root passes W_OK everywhere; a writable non-unit parent must not activate.
    const plain = path.join(cgroupRoot, "x");
    fs.mkdirSync(path.join(plain, "main"), { recursive: true });
    fs.writeFileSync(path.join(plain, "cgroup.procs"), "");
    writeSelfCgroup("/x/main");
    const placement = createChildCgroupPlacement(options());
    expect(placement.active).toBe(false);
    expect(placement.reason).toContain("not a systemd service or scope");
    expect(fs.existsSync(path.join(plain, "children"))).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not throw when the pid write fails and warns once before deactivating", () => {
    makeDelegatedUnit();
    const placement = createChildCgroupPlacement(options());
    // A directory in place of cgroup.procs makes every write fail with EISDIR.
    fs.mkdirSync(path.join(unitDir, "children", "cgroup.procs"));
    expect(() => placement.place(4242)).not.toThrow();
    for (let pid = 4243; pid < 4246; pid += 1) {
      expect(placement.place(pid)).toBe(false);
    }
    expect(placement.active).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("deactivates after five consecutive move failures with one more warning", () => {
    makeDelegatedUnit();
    writeProcStat(10, GATEWAY_PID);
    fs.writeFileSync(path.join(unitDir, "main", "cgroup.procs"), `${GATEWAY_PID}\n10\n`);
    const placement = createChildCgroupPlacement(options());
    const target = path.join(unitDir, "children", "cgroup.procs");
    fs.mkdirSync(target);
    for (let pid = 4242; pid < 4247; pid += 1) {
      placement.place(pid);
    }
    expect(placement.active).toBe(false);
    expect(placement.reason).toContain("5 consecutive failures");
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining("deactivated"));
    // Once inactive it stops writing, sweeping and warning, even if the target heals.
    fs.rmdirSync(target);
    fs.writeFileSync(target, "");
    expect(placement.place(5000)).toBe(false);
    expect(placement.sweep()).toBe(0);
    expect(childrenProcs()).toBe("");
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("resets the failure count after a successful move and ignores exited children", () => {
    makeDelegatedUnit();
    const placement = createChildCgroupPlacement(options());
    const target = path.join(unitDir, "children", "cgroup.procs");
    const write = vi.spyOn(fs, "writeFileSync");
    const fail = (code: string) =>
      write.mockImplementationOnce(() => {
        throw Object.assign(new Error(code), { code });
      });
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 4; i += 1) {
        fail("EBUSY");
        placement.place(4242);
      }
      placement.place(4343);
    }
    for (let i = 0; i < 10; i += 1) {
      fail("ESRCH");
      placement.place(4242);
    }
    write.mockRestore();
    expect(placement.active).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("4343");
  });

  it("sweeps only the Gateway's descendants out of main/", () => {
    makeDelegatedUnit();
    writeProcStat(GATEWAY_PID, 1291);
    writeProcStat(10, GATEWAY_PID);
    writeProcStat(11, 10, "weird) name");
    writeProcStat(20, 1291);
    fs.writeFileSync(path.join(unitDir, "main", "cgroup.procs"), `${GATEWAY_PID}\n10\n11\n20\n`);
    const placement = createChildCgroupPlacement(options());
    const target = path.join(unitDir, "children", "cgroup.procs");
    const write = vi.spyOn(fs, "writeFileSync");
    expect(placement.sweep()).toBe(2);
    const moved = write.mock.calls.filter(([file]) => file === target).map(([, pid]) => pid);
    write.mockRestore();
    // The unrelated sibling (an ancestor launcher's other child) stays in main/.
    expect(moved).toEqual(["10", "11"]);
  });

  it("sets main/memory.low and enables the memory controller when configured", () => {
    makeDelegatedUnit();
    createChildCgroupPlacement(options({ env: { OPENCLAW_GATEWAY_MEMORY_LOW: "4G" } }));
    expect(fs.readFileSync(path.join(unitDir, "cgroup.subtree_control"), "utf8")).toBe("+memory");
    expect(fs.readFileSync(path.join(unitDir, "main", "memory.low"), "utf8")).toBe("4G");
    createChildCgroupPlacement(options({ env: { OPENCLAW_GATEWAY_MEMORY_LOW: "lots" } }));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("not applied"));
  });

  it("stays active when enabling the memory controller fails", () => {
    makeDelegatedUnit();
    const subtreeControl = path.join(unitDir, "cgroup.subtree_control");
    const realWrite = fs.writeFileSync;
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, opts) => {
      if (file === subtreeControl) {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      }
      realWrite(file, data, opts);
    });
    const placement = createChildCgroupPlacement(
      options({ env: { OPENCLAW_GATEWAY_MEMORY_LOW: "4G" } }),
    );
    write.mockRestore();
    expect(placement.active).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("memory.low not applied (EBUSY)"),
    );
    expect(fs.existsSync(path.join(unitDir, "main", "memory.low"))).toBe(false);
    expect(placement.place(4242)).toBe(true);
    expect(childrenProcs()).toBe("4242");
  });
});

describe("placeChildInChildCgroup", () => {
  it("is inert until the Gateway enables placement", () => {
    makeDelegatedUnit();
    expect(() => placeChildInChildCgroup({ pid: 4242, once: vi.fn() } as never)).not.toThrow();
    expect(fs.existsSync(path.join(unitDir, "children"))).toBe(false);
  });

  it("places a spawned child, waiting for the spawn event when the pid is pending", () => {
    makeDelegatedUnit();
    expect(enableGatewayChildCgroupPlacement(options()).active).toBe(true);
    placeChildInChildCgroup({ pid: 4242, once: vi.fn() } as never);
    expect(childrenProcs()).toBe("4242");
    const pending = Object.assign(new EventEmitter(), { pid: undefined as number | undefined });
    placeChildInChildCgroup(pending as never);
    pending.pid = 5151;
    pending.emit("spawn");
    expect(childrenProcs()).toBe("5151");
  });
});
