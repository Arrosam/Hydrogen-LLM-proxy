import type { ActiveRequestRegistry, ProgressPhase } from "./activeRequests";

/**
 * A lightweight, no-op-by-default progress recorder. Threaded through the
 * execution chain (InvokeOptions, ServiceDeps, MicroAgentDeps) so deep layers
 * can emit progress events without a hard dependency on the registry.
 *
 * The recorder carries the traceId so layers don't need to know it themselves.
 * When `registry` is null (e.g. in tests or the dry-run route), all methods
 * are no-ops — zero overhead.
 */
export class ProgressRecorder {
  constructor(
    private readonly registry: ActiveRequestRegistry | null,
    private readonly traceId: string,
  ) {}

  /** Record a progress event. No-op when no registry is attached. */
  record(phase: ProgressPhase, node: string, message: string, detail?: Record<string, unknown>): void {
    if (!this.registry) return;
    this.registry.record(this.traceId, phase, node, message, detail);
  }

  /** Whether recording is active. */
  get enabled(): boolean {
    return this.registry !== null;
  }
}

/** A null recorder for contexts without progress tracking (tests, dry-runs). */
export function nullRecorder(): ProgressRecorder {
  return new ProgressRecorder(null, "");
}
