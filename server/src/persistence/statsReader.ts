import { Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import type { StatsAccumulators } from "./statsQueries";
import type { StartupEvent, StartupReporter } from "../util/startup";

export interface StatsReadTask {
  result: Promise<StatsAccumulators>;
  stopped?: Promise<void>;
  cancel(): void;
}
export type StatsReader = (sinceId: number, throughId: number) => StatsReadTask;
export interface StatsWorkerData { databasePath: string; sinceId: number; throughId: number }
let activeWorker: Worker | null = null;

/** One short-lived readonly reader. No migrations, credentials or writes. */
export function startStatsReader(databasePath: string, sinceId: number, throughId: number, report?: StartupReporter): StatsReadTask {
  if (activeWorker) throw new Error("A statistics reader is still active or stopping");
  const entryDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null;
  const relativeCandidates = process.env.NODE_ENV === "production"
    ? ["server/dist/stats-worker.cjs", "dist/stats-worker.cjs"]
    : ["server/src/persistence/statsWorker.dev.mjs", "src/persistence/statsWorker.dev.mjs", "server/dist/stats-worker.cjs", "dist/stats-worker.cjs"];
  // Explicit MIGRATIONS_DIR/WEB_DIR already allow launch outside the repo cwd.
  // Prefer the worker next to the actual server entrypoint for that case.
  const adjacentCandidates = entryDir ? [path.join(entryDir, "stats-worker.cjs")] : [];
  if (entryDir && process.env.NODE_ENV !== "production") adjacentCandidates.push(path.join(entryDir, "persistence/statsWorker.dev.mjs"));
  const candidates = [...adjacentCandidates, ...relativeCandidates];
  const filename = candidates.map(p => path.resolve(p)).find(p => fs.existsSync(p));
  if (!filename) throw new Error("Statistics worker entrypoint is unavailable");
  const worker = new Worker(filename, { workerData: { databasePath, sinceId, throughId } satisfies StatsWorkerData });
  activeWorker = worker;
  const release = () => { if (activeWorker === worker) activeWorker = null; };
  let rejectResult: (error: Error) => void;
  let settled = false;
  const stopped = new Promise<void>(resolve => worker.once("exit", () => { release(); resolve(); }));
  const result = new Promise<StatsAccumulators>((resolve, reject) => {
    rejectResult = reject;
    worker.on("message", (message: { kind: "startup"; event: StartupEvent } | { kind: "result"; accumulator: StatsAccumulators } | { kind: "failed" }) => {
      if (settled) return;
      if (message.kind === "startup") { try { report?.(message.event); } catch { /* diagnostics */ } }
      else if (message.kind === "result") { release(); settled = true; resolve(message.accumulator); }
      else { settled = true; reject(new Error("Statistics initialization failed")); }
    });
    worker.once("error", () => { if (!settled) { settled = true; reject(new Error("Statistics worker failed")); } });
    worker.once("exit", () => { release(); if (!settled) { settled = true; reject(new Error("Statistics worker exited without a result")); } });
  });
  // A native disk read can delay termination; shutdown must not wait for it.
  worker.unref();
  return { result, stopped, cancel() {
    if (!settled) { settled = true; rejectResult!(new Error("Statistics initialization cancelled")); }
    void worker.terminate().catch(() => {});
  } };
}
