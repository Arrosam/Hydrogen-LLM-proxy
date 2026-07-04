import type { AdvanceTrigger, MubStep, MubSteps, Trigger } from "./schema";

export type FailureKind = "http" | "timeout" | "error";

export interface AttemptSuccess<T> {
  ok: true;
  value: T;
}
export interface AttemptFailure {
  ok: false;
  status: number; // HTTP status, or 0 for transport/timeout/config errors
  kind: FailureKind;
  message: string;
  errorBody?: unknown;
}
export type AttemptResult<T> = AttemptSuccess<T> | AttemptFailure;

/** One recorded attempt, persisted to request_logs.attempt_path_json. */
export interface AttemptRecord {
  step: number; // 1-based
  attempt: number; // 1-based within the step
  model: string;
  provider: string;
  status: number;
  kind: FailureKind | "ok";
  latencyMs: number;
  error?: string;
  /** Chain MUBs only: the stage this attempt belongs to. */
  stage?: string;
  /** Chain MUBs only: the resilience MUB the stage ran (omitted for inline steps / routers). */
  mub?: string;
}

export interface RunOutput<T> {
  result: AttemptResult<T>;
  path: AttemptRecord[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function triggerMatches(set: Trigger[], f: AttemptFailure): boolean {
  for (const t of set) {
    if (t === "error") return true;
    if (t === "timeout" && f.kind === "timeout") return true;
    if (typeof t === "number" && f.kind === "http" && t === f.status) return true;
  }
  return false;
}

function shouldAdvance(advanceOn: AdvanceTrigger[] | undefined, f: AttemptFailure): boolean {
  // Default (omitted): advance to the next step on any failure.
  if (!advanceOn) return true;
  if (advanceOn.includes("exhausted")) return true;
  return triggerMatches(advanceOn.filter((t): t is Trigger => t !== "exhausted"), f);
}

function errMessage(e: unknown): { kind: FailureKind; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError" || /timed out|timeout/i.test(message)) {
    return { kind: "timeout", message };
  }
  return { kind: "error", message };
}

/**
 * Execute a MUB's ordered steps against `attempt`, applying per-step retry and
 * step-advance rules. Returns the first success, or the last failure once every
 * step is exhausted (which the caller translates back to the client).
 *
 * `attempt` is injected so the engine stays pure and testable: the proxy wires
 * it to do a real upstream call + translation; tests wire it to a fake.
 */
export async function runSteps<T>(
  steps: MubSteps,
  attempt: (step: MubStep, stepIndex: number) => Promise<AttemptResult<T>>,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<RunOutput<T>> {
  const sleep = opts.sleep ?? defaultSleep;
  const path: AttemptRecord[] = [];
  let lastFailure: AttemptFailure | null = null;

  for (let i = 0; i < steps.steps.length; i++) {
    const step: MubStep = steps.steps[i];
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    const retryOn = step.retry?.on ?? [];
    const intervalMs = step.retry?.intervalMs ?? 0;

    let stepFailure: AttemptFailure | null = null;

    for (let a = 1; a <= maxAttempts; a++) {
      const start = Date.now();
      let res: AttemptResult<T>;
      try {
        res = await attempt(step, i);
      } catch (e) {
        const { kind, message } = errMessage(e);
        res = { ok: false, status: 0, kind, message };
      }
      const latencyMs = Date.now() - start;

      if (res.ok) {
        path.push({
          step: i + 1,
          attempt: a,
          model: step.model,
          provider: step.provider,
          status: 200,
          kind: "ok",
          latencyMs,
        });
        return { result: res, path };
      }

      path.push({
        step: i + 1,
        attempt: a,
        model: step.model,
        provider: step.provider,
        status: res.status,
        kind: res.kind,
        latencyMs,
        error: res.message,
      });
      stepFailure = res;
      lastFailure = res;

      const canRetry = a < maxAttempts && triggerMatches(retryOn, res);
      if (canRetry) {
        if (intervalMs > 0) await sleep(intervalMs);
        continue;
      }
      break;
    }

    const isLastStep = i === steps.steps.length - 1;
    if (isLastStep) break;
    if (stepFailure && shouldAdvance(step.advanceOn, stepFailure)) continue;
    break;
  }

  return {
    result: lastFailure ?? { ok: false, status: 502, kind: "error", message: "no steps executed" },
    path,
  };
}
