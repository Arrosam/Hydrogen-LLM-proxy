export interface StartupEvent {
  event: "startup";
  stage: string;
  phase: "begin" | "done" | "error";
  elapsedMs?: number;
  operation?: string;
}
export type StartupReporter = (event: StartupEvent) => void;

/** Static labels only: no SQL, parameters, config, paths or exception text. */
export function reportStartup(report: StartupReporter | undefined, stage: string, phase: StartupEvent["phase"], extra: Pick<StartupEvent, "elapsedMs" | "operation"> = {}): void {
  try { report?.({ event: "startup", stage, phase, ...extra }); } catch { /* optional diagnostics */ }
}

export function startupStage<T>(report: StartupReporter | undefined, stage: string, run: () => T): T {
  reportStartup(report, stage, "begin");
  const start = performance.now();
  try {
    const result = run();
    reportStartup(report, stage, "done", { elapsedMs: Math.round(performance.now() - start) });
    return result;
  } catch (error) {
    reportStartup(report, stage, "error", { elapsedMs: Math.round(performance.now() - start) });
    throw error;
  }
}

export async function startupStageAsync<T>(report: StartupReporter | undefined, stage: string, run: () => Promise<T>): Promise<T> {
  reportStartup(report, stage, "begin");
  const start = performance.now();
  try {
    const result = await run();
    reportStartup(report, stage, "done", { elapsedMs: Math.round(performance.now() - start) });
    return result;
  } catch (error) {
    reportStartup(report, stage, "error", { elapsedMs: Math.round(performance.now() - start) });
    throw error;
  }
}
