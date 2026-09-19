import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { parseCgroupLimit, containerMemoryMb, heapAlreadySized, ensureHeapSized } from "../src/util/heap";

describe("cgroup memory parsing", () => {
  it("reads a real byte limit as MiB", () => {
    expect(parseCgroupLimit("4294967296")).toBe(4096);
    expect(parseCgroupLimit("536870912")).toBe(512);
    expect(parseCgroupLimit("  1073741824\n")).toBe(1024);
  });

  it("treats cgroup's no-limit spellings as absent", () => {
    expect(parseCgroupLimit("max")).toBeUndefined();
    expect(parseCgroupLimit("")).toBeUndefined();
    expect(parseCgroupLimit(undefined)).toBeUndefined();
    expect(parseCgroupLimit("9223372036854771712")).toBeUndefined(); // v1 unlimited sentinel
    expect(parseCgroupLimit("1099511627776")).toBeUndefined(); // exactly 1 TiB
    expect(parseCgroupLimit("not-a-number")).toBeUndefined();
  });

  it("reads the first cgroup file that has a usable limit", () => {
    const files: Record<string, string | undefined> = {
      "/sys/fs/cgroup/memory.max": "2147483648",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "536870912",
    };
    expect(containerMemoryMb((p) => files[p])).toBe(2048);
    expect(containerMemoryMb(() => undefined)).toBeUndefined();
  });
});

describe("heapAlreadySized", () => {
  it("detects an operator-supplied ceiling in execArgv or NODE_OPTIONS", () => {
    expect(heapAlreadySized(["--max-old-space-size=512"], undefined)).toBe(true);
    expect(heapAlreadySized([], "--max-old-space-size=512")).toBe(true);
    expect(heapAlreadySized([], "--max_old_space_size=512")).toBe(true);
    expect(heapAlreadySized([], undefined)).toBe(false);
    expect(heapAlreadySized(["--enable-source-maps"], "")).toBe(false);
  });
});

/** A spawn stand-in: records the call and exposes the child surface used. */
function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const child = new EventEmitter() as EventEmitter & { kill: (s: string) => boolean };
  child.kill = vi.fn(() => true);
  const spawnFn = ((cmd: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: o.env });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, child, spawnFn };
}

describe("ensureHeapSized", () => {
  const base = { argv: ["node", "server.cjs"], execArgv: [] as string[] };

  it("does nothing when no container limit is detectable", () => {
    const { calls, spawnFn } = fakeSpawn();
    const respawned = ensureHeapSized({ ...base, env: {}, read: () => undefined, spawnFn, onExit: () => undefined });
    expect(respawned).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("re-execs with the container's memory as the heap ceiling (100% by default)", () => {
    const { calls, spawnFn } = fakeSpawn();
    const respawned = ensureHeapSized({
      ...base, env: {}, read: () => "4294967296", spawnFn, onExit: () => undefined,
    });
    expect(respawned).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--max-old-space-size=4096");
    expect(calls[0].env.HYDROGEN_HEAP_RESPAWNED).toBe("1");
  });

  it("never re-execs an eval launch (the Docker healthcheck uses node -e)", () => {
    const { calls, spawnFn } = fakeSpawn();
    const respawned = ensureHeapSized({
      argv: ["node"], execArgv: ["-e", "fetch(process.env.HEALTH)"], env: {},
      read: () => "4294967296", spawnFn, onExit: () => undefined,
    });
    expect(respawned).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("honours NODE_HEAP_PERCENT", () => {
    const { calls, spawnFn } = fakeSpawn();
    ensureHeapSized({ ...base, env: { NODE_HEAP_PERCENT: "80" }, read: () => "4294967296", spawnFn, onExit: () => undefined });
    expect(calls[0].args).toContain("--max-old-space-size=3276");
  });

  it("never re-execs when a ceiling already exists or autosizing is off", () => {
    for (const [env, execArgv] of [
      [{}, ["--max-old-space-size=512"]],
      [{ NODE_OPTIONS: "--max-old-space-size=512" }, []],
      [{ HYDROGEN_HEAP_AUTOSIZE: "0" }, []],
      [{ HYDROGEN_HEAP_RESPAWNED: "1" }, []],
    ] as Array<[NodeJS.ProcessEnv, string[]]>) {
      const { calls, spawnFn } = fakeSpawn();
      expect(ensureHeapSized({ argv: base.argv, execArgv, env, read: () => "4294967296", spawnFn, onExit: () => undefined })).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });
});
