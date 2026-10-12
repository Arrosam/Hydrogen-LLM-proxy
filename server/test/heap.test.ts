import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { parseCgroupLimit, containerMemoryMb, heapAlreadySized, ensureHeapSized, inContainer } from "../src/util/heap";

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

  it("detects a container from /.dockerenv or the cgroup path", () => {
    expect(inContainer((p) => (p === "/.dockerenv" ? "" : undefined))).toBe(true);
    expect(inContainer((p) => (p === "/proc/1/cgroup" ? "0::/docker/abc" : undefined))).toBe(true);
    expect(inContainer(() => undefined)).toBe(false);
  });

  // A plain docker run without --memory leaves memory.max at "max", so Node
  // keeps its own ~half-the-host default -- the artificial cap that made the
  // container abort long before the RAM the operator allocated.
  it("falls back to the host RAM inside a container with no cgroup limit", () => {
    const { calls, spawnFn } = fakeSpawn();
    const read = (p: string) => (p === "/.dockerenv" ? "" : p === "/sys/fs/cgroup/memory.max" ? "max" : undefined);
    const respawned = ensureHeapSized({ ...base, env: {}, read, totalMemMb: 3915, spawnFn, onExit: () => undefined });
    expect(respawned).toBe(true);
    expect(calls[0].args).toContain("--max-old-space-size=3915");
  });

  it("does not size from host memory outside a container", () => {
    const { calls, spawnFn } = fakeSpawn();
    const respawned = ensureHeapSized({ ...base, env: {}, read: () => undefined, totalMemMb: 3915, spawnFn, onExit: () => undefined });
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

describe("cgroup memory parsing: boundaries", () => {
  it("never reports a real limit below 1 MiB as zero", () => {
    expect(parseCgroupLimit("1048575")).toBe(1); // one byte short of a MiB
    expect(parseCgroupLimit("1")).toBe(1);
    expect(parseCgroupLimit("1048576")).toBe(1);
  });

  it("treats zero as no limit, and the last byte below 1 TiB as a real one", () => {
    expect(parseCgroupLimit("0")).toBeUndefined();
    expect(parseCgroupLimit("1099511627775")).toBe(1048575);
  });

  it("rejects signed and fractional values rather than guessing", () => {
    expect(parseCgroupLimit("-1")).toBeUndefined();
    expect(parseCgroupLimit("1.5e9")).toBeUndefined();
  });
});

describe("ensureHeapSized: sizing floor, percent and child supervision", () => {
  const base = { argv: ["node", "server.cjs"], execArgv: [] as string[] };
  const MIB = 1024 * 1024;

  // Every re-exec hooks SIGTERM/SIGINT on the real process and prints a line;
  // neither should outlive the test that caused it.
  let sigterm: NodeJS.SignalsListener[];
  let sigint: NodeJS.SignalsListener[];
  beforeEach(() => {
    sigterm = process.listeners("SIGTERM");
    sigint = process.listeners("SIGINT");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const l of process.listeners("SIGTERM")) if (!sigterm.includes(l)) process.removeListener("SIGTERM", l);
    for (const l of process.listeners("SIGINT")) if (!sigint.includes(l)) process.removeListener("SIGINT", l);
    vi.restoreAllMocks();
  });

  /** The --max-old-space-size the child was started with for this container. */
  function sizedFor(limitMb: number, env: NodeJS.ProcessEnv = {}): string | undefined {
    const { calls, spawnFn } = fakeSpawn();
    ensureHeapSized({ ...base, env, read: () => String(limitMb * MIB), spawnFn, onExit: () => undefined });
    return calls[0]?.args.find((a) => a.startsWith("--max-old-space-size="));
  }

  it("never sizes the heap below 128 MiB, however small the container", () => {
    expect(sizedFor(64)).toBe("--max-old-space-size=128");
    expect(sizedFor(128)).toBe("--max-old-space-size=128");
    expect(sizedFor(129)).toBe("--max-old-space-size=129");
  });

  it("applies the floor after the percent, not before", () => {
    expect(sizedFor(200, { NODE_HEAP_PERCENT: "50" })).toBe("--max-old-space-size=128");
    expect(sizedFor(4096, { NODE_HEAP_PERCENT: "50" })).toBe("--max-old-space-size=2048");
  });

  it.each(["0", "101", "abc", "-5", ""])("falls back to 100%% for NODE_HEAP_PERCENT=%j", (percent) => {
    expect(sizedFor(4096, { NODE_HEAP_PERCENT: percent })).toBe("--max-old-space-size=4096");
  });

  it("accepts the whole 0 < percent <= 100 range, fractions included", () => {
    expect(sizedFor(4096, { NODE_HEAP_PERCENT: "100" })).toBe("--max-old-space-size=4096");
    expect(sizedFor(4096, { NODE_HEAP_PERCENT: "12.5" })).toBe("--max-old-space-size=512");
  });

  it("puts the heap flag after the existing exec flags and before the script and its arguments", () => {
    const { calls, spawnFn } = fakeSpawn();
    ensureHeapSized({
      argv: ["node", "server.cjs", "--port", "8080"], execArgv: ["--enable-source-maps"], env: { KEEP: "me" },
      read: () => String(512 * MIB), spawnFn, onExit: () => undefined,
    });
    expect(calls[0].cmd).toBe(process.execPath);
    expect(calls[0].args).toEqual(["--enable-source-maps", "--max-old-space-size=512", "server.cjs", "--port", "8080"]);
    expect(calls[0].env).toMatchObject({ KEEP: "me", HYDROGEN_HEAP_RESPAWNED: "1" });
  });

  it.each(["-p", "--print", "--eval"])("never re-execs a %s launch", (flag) => {
    const { calls, spawnFn } = fakeSpawn();
    const respawned = ensureHeapSized({
      argv: ["node", "server.cjs"], execArgv: [flag, "1+1"], env: {},
      read: () => "4294967296", spawnFn, onExit: () => undefined,
    });
    expect(respawned).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("never re-execs when there is no script path to relaunch", () => {
    const { calls, spawnFn } = fakeSpawn();
    expect(ensureHeapSized({ argv: ["node"], execArgv: [], env: {}, read: () => "4294967296", spawnFn, onExit: () => undefined })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  /** Start a supervised child and collect what the parent would exit with. */
  function supervised() {
    const { child, spawnFn } = fakeSpawn();
    const exits: number[] = [];
    ensureHeapSized({ ...base, env: {}, read: () => "4294967296", spawnFn, onExit: (code) => exits.push(code) });
    return { child, exits };
  }

  it("exits with the child's own exit code", () => {
    const { child, exits } = supervised();
    child.emit("exit", 3, null);
    expect(exits).toEqual([3]);
  });

  it("exits 0 when the child exits cleanly or reports no code at all", () => {
    const clean = supervised();
    clean.child.emit("exit", 0, null);
    expect(clean.exits).toEqual([0]);
    const codeless = supervised();
    codeless.child.emit("exit", null, null);
    expect(codeless.exits).toEqual([0]);
  });

  it("exits 1 when the child was killed by a signal", () => {
    const { child, exits } = supervised();
    child.emit("exit", null, "SIGKILL");
    expect(exits).toEqual([1]);
  });

  it("exits 1 when the child could not be started", () => {
    const { child, exits } = supervised();
    child.emit("error", new Error("spawn ENOENT"));
    expect(exits).toEqual([1]);
  });

  it("forwards SIGTERM and SIGINT to the child", () => {
    const { child } = supervised();
    const added = (signal: "SIGTERM" | "SIGINT", before: NodeJS.SignalsListener[]) =>
      process.listeners(signal).filter((l) => !before.includes(l));
    for (const l of added("SIGTERM", sigterm)) l("SIGTERM");
    for (const l of added("SIGINT", sigint)) l("SIGINT");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
  });
});
