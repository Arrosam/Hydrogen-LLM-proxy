/**
 * In-memory registry of in-flight (serving) requests with real-time progress
 * tracking. Each request accumulates an ordered list of progress events as it
 * moves through the pipeline (parse -> resolve -> agent stages -> upstream
 * send/receive -> retry -> done). The registry is polled by the admin dashboard
 * via GET /admin/api/active-requests (refresh interval <= 500ms).
 *
 * Design:
 *  - A single Map<traceId, ActiveRequest> guarded by no lock (Node is
 *    single-threaded; all mutations happen in async steps on the event loop).
 *  - Progress events are appended in O(1) via a simple array push.
 *  - Completed requests are removed from the map but retained in a small ring
 *    buffer (default 256) so the dashboard can show the final state of recently
 *    finished requests (useful for catching the moment a blocked request
 *    completes).
 *  - A "blocked" flag is computed from elapsed time > BLOCK_THRESHOLD_MS (30s).
 */

/** One progress event in a request's lifecycle. */
export interface ProgressEvent {
  /** Epoch ms when this event was recorded. */
  ts: number;
  /** Coarse phase for grouping in the UI. */
  phase: ProgressPhase;
  /** Machine-readable node id (e.g. "agent.stage.start", "llm.send"). */
  node: string;
  /** Human-readable message. */
  message: string;
  /** Optional structured payload (status code, retry index, etc.). */
  detail?: Record<string, unknown>;
}

/** Coarse phases that map to the required progress dimensions. */
export type ProgressPhase =
  | "init" // request received, parsed, service resolved
  | "agent" // Micro Agent execution phases
  | "llm" // LLM request send/receive chain
  | "retry" // retry trigger + attempt
  | "done" // final status (completed / failed / client-disconnected)
  | "error"; // unexpected error

export interface ActiveRequest {
  traceId: string;
  tokenId: number | null;
  serviceId: number | null;
  serviceName: string | null;
  ingress: string;
  streaming: boolean;
  startedAt: number;
  /** Last-updated-at; used to detect stale entries. */
  updatedAt: number;
  /** Final HTTP status (set when done). null while in-flight. */
  httpStatus: number | null;
  /** True when the request has finished (success/fail/disconnect). */
  done: boolean;
  /** Error message if the request ended in failure. */
  error: string | null;
  /** Ordered progress events. */
  events: ProgressEvent[];
}

/** Requests older than this (elapsed since startedAt) are flagged as blocked. */
export const BLOCK_THRESHOLD_MS = 30_000;

/** Max completed requests retained in the ring buffer for late polling. */
const DEFAULT_RETENTION = 256;

/**
 * The active-request registry. Injected into the proxy controller, executors,
 * and transport layer to record progress events. Queried by the admin API.
 */
export class ActiveRequestRegistry {
  private readonly active = new Map<string, ActiveRequest>();
  private readonly completed: ActiveRequest[] = [];
  private readonly retention: number;
  /** Monotonic counter for total events recorded (for perf monitoring). */
  private totalEvents = 0;

  constructor(retention = DEFAULT_RETENTION) {
    this.retention = retention;
  }

  /** Register a new in-flight request. Called at the start of handleChat. */
  start(req: {
    traceId: string;
    tokenId: number | null;
    serviceId: number | null;
    serviceName: string | null;
    ingress: string;
    streaming: boolean;
  }): void {
    const now = Date.now();
    const entry: ActiveRequest = {
      traceId: req.traceId,
      tokenId: req.tokenId,
      serviceId: req.serviceId,
      serviceName: req.serviceName,
      ingress: req.ingress,
      streaming: req.streaming,
      startedAt: now,
      updatedAt: now,
      httpStatus: null,
      done: false,
      error: null,
      events: [],
    };
    this.active.set(req.traceId, entry);
  }

  /** Append a progress event to an in-flight request. No-op if not registered. */
  record(traceId: string, phase: ProgressPhase, node: string, message: string, detail?: Record<string, unknown>): void {
    const entry = this.active.get(traceId);
    if (!entry) return; // not tracked (e.g. embeddings or pre-registration errors)
    const ev: ProgressEvent = { ts: Date.now(), phase, node, message, detail };
    entry.events.push(ev);
    entry.updatedAt = ev.ts;
    this.totalEvents++;
  }

  /** Mark a request as finished and move it to the completed ring buffer. */
  finish(traceId: string, httpStatus: number, error?: string | null): void {
    const entry = this.active.get(traceId);
    if (!entry) return;
    entry.done = true;
    entry.httpStatus = httpStatus;
    entry.error = error ?? null;
    entry.updatedAt = Date.now();
    this.active.delete(traceId);
    this.completed.push(entry);
    if (this.completed.length > this.retention) {
      this.completed.splice(0, this.completed.length - this.retention);
    }
  }

  /** All currently in-flight requests (snapshot copy). */
  listActive(): ActiveRequest[] {
    return Array.from(this.active.values());
  }

  /** Recently completed requests (newest first). */
  listCompleted(limit = 50): ActiveRequest[] {
    return this.completed.slice(-limit).reverse();
  }

  /** A single request by traceId (active or completed). */
  get(traceId: string): ActiveRequest | undefined {
    return this.active.get(traceId) ?? this.completed.find((r) => r.traceId === traceId);
  }

  /** Total events recorded (for performance tests). */
  stats(): { active: number; completed: number; totalEvents: number } {
    return { active: this.active.size, completed: this.completed.length, totalEvents: this.totalEvents };
  }

  /** Clear all state (for tests). */
  clear(): void {
    this.active.clear();
    this.completed.length = 0;
    this.totalEvents = 0;
  }
}
