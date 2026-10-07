import { Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import type { RetentionCursor, RetentionResult } from "./responseRetention";
import type { ResponsePruneWorkerData } from "./responsePruneWorker";

export interface ResponsePruneTask { result: Promise<RetentionResult>; stopped: Promise<void>; cancel(): void }
export type ResponsePruneRunner = (databasePath: string, cursor: RetentionCursor) => ResponsePruneTask;

export function startResponsePrune(databasePath: string, cursor: RetentionCursor): ResponsePruneTask {
  const entryDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null;
  const candidates = [
    ...(entryDir ? [path.join(entryDir, "response-prune-worker.cjs")] : []),
    ...(process.env.NODE_ENV !== "production" ? [
      ...(entryDir ? [path.join(entryDir, "persistence/responsePruneWorker.dev.mjs")] : []),
      "server/src/persistence/responsePruneWorker.dev.mjs", "src/persistence/responsePruneWorker.dev.mjs",
    ] : []),
    "server/dist/response-prune-worker.cjs", "dist/response-prune-worker.cjs",
  ];
  const filename = candidates.map(p => path.resolve(p)).find(p => fs.existsSync(p));
  if (!filename) throw new Error("Response retention worker entrypoint is unavailable");
  const worker = new Worker(filename, { workerData: { databasePath, cursor } satisfies ResponsePruneWorkerData });
  let rejectResult!: (error: Error) => void, settled = false;
  const stopped = new Promise<void>(resolve => worker.once("exit", () => resolve()));
  const result = new Promise<RetentionResult>((resolve, reject) => {
    rejectResult = reject;
    worker.on("message", (message: { kind: "result"; result: RetentionResult } | { kind: "failed"; busy: boolean }) => {
      if (settled) return;
      settled = true;
      if (message.kind === "result") resolve(message.result);
      else reject(new Error(message.busy ? "Response retention deferred: database busy" : "Response retention failed"));
    });
    worker.once("error", () => { if (!settled) { settled = true; reject(new Error("Response retention worker failed")); } });
    worker.once("exit", () => { if (!settled) { settled = true; reject(new Error("Response retention worker exited without a result")); } });
  });
  worker.unref();
  return { result, stopped, cancel() {
    if (!settled) { settled = true; rejectResult(new Error("Response retention cancelled")); }
    void worker.terminate().catch(() => {});
  } };
}

/** Completion-relative schedule: one worker, no overlap/catch-up or inline fallback. */
export class ResponsePruner {
  private cursor: RetentionCursor = { responses: null, conversations: null };
  private task: ResponsePruneTask | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private paused = false;
  private closed = false;
  private report: (result: RetentionResult) => void = () => {};
  private failed: (error: Error) => void = () => {};
  constructor(private readonly databasePath: string, private readonly runner: ResponsePruneRunner = startResponsePrune,
    private readonly intervalMs = 60_000) {}

  start(report: (result: RetentionResult) => void, failed: (error: Error) => void): void {
    if (this.started || this.closed) return;
    this.started = true; this.report = report; this.failed = failed;
    this.schedule(0);
  }
  /** Settings writes return promptly; an active worker re-reads each batch. */
  request(): void {
    if (!this.started || this.paused || this.closed || this.task) return;
    this.schedule(0);
  }
  async pause(): Promise<void> {
    this.paused = true; this.clearTimer();
    const task = this.task;
    if (task) {
      task.cancel();
      // A cancelled native call may still be unwinding. Never race it with restore.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([task.stopped, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(Object.assign(new Error("Wait for response retention to stop before restoring"), { statusCode: 503 })), 5_000);
        })]);
      } finally { if (timeout) clearTimeout(timeout); }
    }
    this.cursor = { responses: null, conversations: null };
  }
  resume(): void {
    this.cursor = { responses: null, conversations: null };
    this.paused = false;
    if (!this.task) this.schedule(0);
  }
  /** Shutdown must not await a native IO stall. The worker is unref'd/terminated. */
  close(): void { this.closed = true; this.clearTimer(); this.task?.cancel(); }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private schedule(delay: number): void {
    if (!this.started || this.paused || this.closed || this.task) return;
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, delay);
    this.timer.unref?.();
  }
  private async run(): Promise<void> {
    try {
      const task = this.runner(this.databasePath, this.cursor);
      this.task = task;
      try {
        const result = await task.result;
        if (!this.closed && !this.paused) { this.cursor = result.cursor; this.report(result); }
      } catch (error) {
        if (!this.closed && !this.paused) this.failed(error instanceof Error ? error : new Error("Response retention failed"));
      } finally {
        // Results can arrive before worker exit. Hold the slot until actual exit.
        await task.stopped;
        if (this.task === task) this.task = null;
      }
    } catch (error) {
      if (!this.closed && !this.paused) this.failed(error instanceof Error ? error : new Error("Response retention failed"));
    } finally { this.schedule(this.intervalMs); }
  }
}
