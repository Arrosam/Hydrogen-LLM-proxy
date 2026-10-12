/**
 * T15 — an out-of-range NODE_HEAP_PERCENT still falls back to 100%, but says so
 * instead of silently ignoring what the operator set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { ensureHeapSized } from "../src/util/heap";

const MIB = 1024 * 1024;
let sigterm: Array<(...a: never[]) => void>, sigint: Array<(...a: never[]) => void>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sigterm = process.listeners("SIGTERM") as never; sigint = process.listeners("SIGINT") as never;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const l of process.listeners("SIGTERM")) if (!sigterm.includes(l as never)) process.removeListener("SIGTERM", l);
  for (const l of process.listeners("SIGINT")) if (!sigint.includes(l as never)) process.removeListener("SIGINT", l);
  vi.restoreAllMocks();
});

function sizedFor(env: NodeJS.ProcessEnv): string | undefined {
  const calls: string[][] = [];
  const spawnFn = ((_cmd: string, args: string[]) => { calls.push(args); return new EventEmitter(); }) as unknown as typeof spawn;
  ensureHeapSized({ execArgv: [], argv: ["node", "/app/server.cjs"], env, read: () => String(4096 * MIB), spawnFn, onExit: () => undefined });
  return calls[0]?.find((a) => a.startsWith("--max-old-space-size="));
}

describe("T15: NODE_HEAP_PERCENT fallback is reported", () => {
  it.each(["0", "101", "abc", "-5"])("warns and uses the whole container for %j", (percent) => {
    expect(sizedFor({ NODE_HEAP_PERCENT: percent })).toBe("--max-old-space-size=4096");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain(`NODE_HEAP_PERCENT=${JSON.stringify(percent)}`);
    expect(String(warn.mock.calls[0]![0])).toContain("100");
  });

  it.each([undefined, "", "  ", "80", "100", "12.5"])("stays quiet for %j", (percent) => {
    sizedFor(percent === undefined ? {} : { NODE_HEAP_PERCENT: percent });
    expect(warn).not.toHaveBeenCalled();
  });
});
