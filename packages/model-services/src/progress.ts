/**
 * Real-time progress reporting, as the narrow port the executors need. The
 * gateway's active-request registry implements it; tests and standalone
 * adopters may pass nothing (every call is a no-op on a null sink).
 */

/** Coarse phases a request moves through. */
export type ProgressPhase =
  | "init" // request received, parsed, service resolved
  | "agent" // orchestration phases (stages)
  | "llm" // LLM request send/receive chain
  | "retry" // retry trigger + attempt
  | "done" // final status (completed / failed / client-disconnected)
  | "error"; // unexpected error

export interface ProgressSink {
  record(phase: ProgressPhase, node: string, message: string, detail?: Record<string, unknown>): void;
  /** Whether recording is active (lets a caller skip building expensive detail). */
  readonly enabled: boolean;
}
