import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

/**
 * Size Node's old-space to the CONTAINER's memory limit.
 *
 * Node derives its default heap ceiling from the machine it runs on, not from
 * the cgroup it is confined to. In a container that is either too generous (the
 * host has more RAM, so V8 grows until the kernel OOM-kills it) or, on many
 * managed-node eggs, too small (a fixed --max-old-space-size left over from a
 * 256 MB plan, which aborts far below the memory the operator actually paid
 * for). Either way the number that matters is the container's -- and a
 * container with no explicit limit at all may use the host's whole RAM, which
 * is far more than Node's own half-the-host default.
 *
 * Node cannot change its own heap ceiling after start, so when the limit is
 * detected and no ceiling was configured we re-exec once with the matching
 * --max-old-space-size. The parent then only supervises that child and forwards
 * signals, so a supervisor's SIGTERM still reaches the app's graceful shutdown.
 *
 * Off by nothing: NODE_HEAP_PERCENT defaults to 100 (the whole container), but
 * the heap is only part of RSS -- Buffers, native SQLite pages and stacks live
 * outside it -- so an operator who sees the kernel kill the process at the
 * ceiling can set NODE_HEAP_PERCENT=80 to leave that room. Set
 * HYDROGEN_HEAP_AUTOSIZE=0 to opt out entirely.
 */

const CGROUP_FILES = [
  "/sys/fs/cgroup/memory.max", // cgroup v2
  "/sys/fs/cgroup/memory/memory.limit_in_bytes", // cgroup v1
];

/** Anything at or above 1 TiB is cgroup's "no limit" sentinel, not a real cap. */
const UNLIMITED_BYTES = 1024 ** 4;

/** Parse one cgroup memory value to MiB, or undefined when absent/unlimited. */
export function parseCgroupLimit(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return undefined; // "max", or a junk value
  const bytes = Number(text);
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes >= UNLIMITED_BYTES) return undefined;
  return Math.max(1, Math.floor(bytes / (1024 * 1024)));
}

/** The container's memory limit in MiB, or undefined when it cannot be read. */
export function containerMemoryMb(
  read: (path: string) => string | undefined = defaultRead,
): number | undefined {
  for (const file of CGROUP_FILES) {
    const mb = parseCgroupLimit(read(file));
    if (mb != null) return mb;
  }
  return undefined;
}

function defaultRead(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Whether we run inside a container. A plain `docker run` without `--memory`
 * leaves `memory.max` at "max", so there is no cgroup number to read and Node
 * keeps its own default ceiling (~half the host) -- exactly the artificial cap
 * this module exists to remove. Inside a container, the host's RAM is the right
 * ceiling to fall back to.
 */
export function inContainer(read: (path: string) => string | undefined = defaultRead): boolean {
  if (read("/.dockerenv") != null) return true;
  const cgroup = read("/proc/1/cgroup");
  return typeof cgroup === "string" && /docker|containerd|kubepods|libpod/.test(cgroup);
}

/** The host's total RAM in MiB: what a container with no explicit limit may use. */
export function hostMemoryMb(): number {
  return Math.max(1, Math.floor(os.totalmem() / (1024 * 1024)));
}

/** Whether a heap ceiling was already requested by the operator. */
export function heapAlreadySized(execArgv: string[], nodeOptions: string | undefined): boolean {
  return execArgv.some((a) => a.startsWith("--max-old-space-size")) ||
    /--max[-_]old[-_]space[-_]size/.test(nodeOptions ?? "");
}

export interface HeapAutosizeOptions {
  read?: (path: string) => string | undefined;
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  argv?: string[];
  spawnFn?: typeof spawn;
  /** Test seam: host RAM in MiB, used when no cgroup limit is set. */
  totalMemMb?: number;
  /** Test seam: called instead of exiting the parent. */
  onExit?: (code: number) => void;
}

/**
 * Re-exec with a container-sized --max-old-space-size when one is needed.
 * Returns true when a child was started and the caller must NOT run the app
 * (the parent's only remaining job is to supervise it).
 */
export function ensureHeapSized(opts: HeapAutosizeOptions = {}): boolean {
  const env = opts.env ?? process.env;
  if (env.HYDROGEN_HEAP_AUTOSIZE === "0" || env.HYDROGEN_HEAP_RESPAWNED === "1") return false;
  const execArgv = opts.execArgv ?? process.execArgv;
  if (heapAlreadySized(execArgv, env.NODE_OPTIONS)) return false;

  // Only an actual script launch can be reconstructed. `node -e` / `-p` (the
  // Docker HEALTHCHECK is `node -e ...`) carries its code in execArgv and has
  // no usable script path, and a flag appended after `-e` would be swallowed as
  // a script argument instead of sizing the heap.
  const argv = opts.argv ?? process.argv;
  if (!argv[1] || execArgv.some((a) => a === "-e" || a === "--eval" || a === "-p" || a === "--print")) return false;

  const cgroupMb = containerMemoryMb(opts.read);
  const source: "container" | "host" | undefined = cgroupMb != null ? "container" : inContainer(opts.read) ? "host" : undefined;
  const mb = cgroupMb ?? (source === "host" ? (opts.totalMemMb ?? hostMemoryMb()) : undefined);
  if (mb == null || source == null) return false;

  const rawPercent = Number(env.NODE_HEAP_PERCENT ?? "100");
  const percent = Number.isFinite(rawPercent) && rawPercent > 0 && rawPercent <= 100 ? rawPercent : 100;
  const sizeMb = Math.max(128, Math.floor((mb * percent) / 100));

  const spawnFn = opts.spawnFn ?? spawn;
  const child = spawnFn(
    process.execPath,
    [...execArgv, `--max-old-space-size=${sizeMb}`, ...argv.slice(1)],
    { stdio: "inherit", env: { ...env, HYDROGEN_HEAP_RESPAWNED: "1" } },
  );

  const forward = (signal: NodeJS.Signals): void => {
    try { child.kill(signal); } catch { /* already gone */ }
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("error", () => (opts.onExit ?? process.exit)(1));
  child.on("exit", (code, signal) => (opts.onExit ?? process.exit)(signal ? 1 : code ?? 0));

  // eslint-disable-next-line no-console
  console.log(`hydrogen: ${source} memory ${mb} MiB -> node --max-old-space-size=${sizeMb} (${percent}%)`);
  return true;
}
