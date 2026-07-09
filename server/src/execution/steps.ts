import type { AdvanceTrigger, BackoffConfig, RetryConfig, ServiceStep, ServiceSteps, Trigger } from "./definition";
import type { ProgressRecorder } from "../observability/progressRecorder";

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
  /** Retry context for 499 and other retried failures. */
  retry?: {
    /** Monotonic retry index within this step (0 = first retry). */
    retryIndex: number;
    /** Delay (ms) applied BEFORE this retry attempt. */
    delayMs: number;
    /** Whether this retry was suppressed by an idempotency guard. */
    suppressed: boolean;
    /** Human-readable reason for the retry decision. */
    reason: string;
  };
}

export interface RunOutput<T> {
  result: AttemptResult<T>;
  path: AttemptRecord[];
}

/**
 * Compute the exponential backoff delay with full jitter for a retry attempt.
 *
 * - attempt >= 2 (the 2nd call overall, 1st retry): base = initialMs
 * - attempt N (Nth call, retry N-1): base = min(initialMs * 2^(N-2), maxMs)
 * - Final delay = random(0, base)  [full jitter — decorrelates service load]
 *
 * For a fixed interval (no backoff config), returns `intervalMs` unchanged.
 */
export function computeRetryDelay(
  attempt: number, // 1-based overall attempt number within this step
  config: RetryConfig | undefined,
): number {
  if (!config) return 0;
  // The first attempt (attempt === 1) never has a pre-delay.
  if (attempt < 2) return 0;
  const backoff: BackoffConfig | undefined = config.backoff;
  if (!backoff) {
    return config.intervalMs ?? 0;
  }
  // Exponential growth: attempt 2 -> 2^0=1, attempt 3 -> 2^1=2, attempt 4 -> 2^2=4 ...
  const exponent = attempt - 2;
  const raw = backoff.initialMs * Math.pow(2, exponent);
  const base = Math.min(raw, backoff.maxMs);
  // Full jitter: uniform random in [0, base).
  return Math.floor(Math.random() * base);
}

/**
 * Determine whether a 499 failure should be retried based on the step's
 * idempotency classification. Non-499 failures are always eligible (they must
 * still match the `retry.on` trigger set).
 *
 * - "read": idempotent — always safe to retry 499 (client closed early on a GET).
 * - "safe_write": the upstream returned 499 before it could process the request
 *   body, so a retry is safe (the server did not mutate state).
 * - "unsafe": the request is non-idempotent and the server MAY have started
 *   processing — 499 is NOT retried; a pre-check (e.g. a GET to verify state)
 *   must confirm safety before retrying.
 */
export function is499Retryable(idempotency: RetryConfig["idempotency"] | undefined): boolean {
  const mode = idempotency ?? "safe_write";
  return mode !== "unsafe";
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
  if (!advanceOn) return true;
  if (advanceOn.includes("exhausted")) return true;
  return triggerMatches(advanceOn.filter((t): t is Trigger => t !== "exhausted"), f);
}

export function classifyError(e: unknown): { kind: FailureKind; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError" || /timed out|timeout/i.test(message)) {
    return { kind: "timeout", message };
  }
  return { kind: "error", message };
}

/**
 * Execute a service's ordered steps against `attempt`, applying per-step retry
 * and step-advance rules. Returns the first success, or the last failure once
 * every step is exhausted. `attempt` is injected so the engine stays pure and
 * testable.
 *
 * Retry policy (applies per step):
 *  - A failure is retried when it matches a trigger in `retry.on` AND, if the
 *    failure is a 499, the step's `idempotency` allows it.
 *  - 499 (client closed connection) is now a default retriable trigger for
 *    "read" and "safe_write" steps. "unsafe" steps never retry 499.
 *  - When `retry.backoff` is set, the delay uses exponential growth with full
 *    jitter (initial 100ms, cap 1s). Otherwise a fixed `intervalMs` is used.
 *  - Maximum 3 retry attempts (configurable via `retry.maxAttempts`, capped 20).
 *
 * Each retried attempt records a `retry` block on its `AttemptRecord` with the
 * retry index, applied delay, suppression flag, and reason — so logs carry the
 * full retry context for diagnosis.
 */
export async function runSteps<T>(
  steps: ServiceSteps,
  attempt: (step: ServiceStep, stepIndex: number) => Promise<AttemptResult<T>>,
  opts: { sleep?: (ms: number) => Promise<void>; progress?: ProgressRecorder | null } = {},
): Promise<RunOutput<T>> {
  const sleep = opts.sleep ?? defaultSleep;
  const prog = opts.progress ?? null;
  const path: AttemptRecord[] = [];
  let lastFailure: AttemptFailure | null = null;

  for (let i = 0; i < steps.steps.length; i++) {
    const step: ServiceStep = steps.steps[i];
    const retry: RetryConfig | undefined = step.retry;
    const maxAttempts = retry?.maxAttempts ?? 3;
    const retryOn = retry?.on ?? [429, 503, 499, "timeout"];
    const idempotency = retry?.idempotency ?? "safe_write";

    let stepFailure: AttemptFailure | null = null;

    for (let a = 1; a <= maxAttempts; a++) {
      // The delay that was applied BEFORE this attempt (0 for attempt 1).
      // Computed once so the log and the actual sleep agree.
      const preDelayMs = a > 1 ? computeRetryDelay(a, retry) : 0;
      if (preDelayMs > 0) {
        prog?.record("retry", "retry.delay", `retry #${a - 1}: sleeping ${preDelayMs}ms before attempt`, { retryIndex: a - 1, delayMs: preDelayMs });
        await sleep(preDelayMs);
      }

      const start = Date.now();
      let res: AttemptResult<T>;
      try {
        res = await attempt(step, i);
      } catch (e) {
        const { kind, message } = classifyError(e);
        res = { ok: false, status: 0, kind, message };
      }
      const latencyMs = Date.now() - start;

      if (res.ok) {
        // On a retried success (a > 1), record the retry context so the log
        // shows which retry succeeded and the delay that was applied.
        const retryCtx: AttemptRecord["retry"] | undefined = a > 1
          ? {
              retryIndex: a - 1,
              delayMs: preDelayMs,
              suppressed: false,
              reason: `succeeded on retry #${a - 1}`,
            }
          : undefined;
        path.push({ step: i + 1, attempt: a, model: step.model, provider: step.provider, status: 200, kind: "ok", latencyMs, retry: retryCtx });
        return { result: res, path };
      }

      // Determine whether a retry is permitted for THIS failure.
      const triggerMatched = triggerMatches(retryOn, res);
      const is499 = res.status === 499;
      const four99Allowed = !is499 || is499Retryable(idempotency);
      const canRetryFlag = a < maxAttempts && triggerMatched && four99Allowed;

      // Emit real-time retry trigger / suppression progress events.
      if (canRetryFlag) {
        prog?.record("retry", "retry.trigger", `attempt ${a} failed (${res.status || res.kind}); retrying`, { retryIndex: a, status: res.status, reason: res.message });
      } else if (a > 1 || triggerMatched) {
        prog?.record("retry", "retry.exhausted", `retries exhausted after ${a} attempt(s)`, { attempts: a, status: res.status });
      }

      // Build the retry context for logging. We log the retry decision on
      // every attempt that either (a) is itself a retry (a > 1), or (b) COULD
      // have been retried (canRetryFlag), or (c) was suppressed specifically
      // because of a 499 idempotency guard. This ensures the log always
      // explains the retry/suppression decision.
      const is499Suppressed = is499 && !four99Allowed;
      let retryCtx: AttemptRecord["retry"] | undefined;
      if (a > 1 || canRetryFlag || is499Suppressed) {
        const retryIndex = a - 1; // 0-based
        retryCtx = {
          retryIndex,
          delayMs: preDelayMs,
          suppressed: !canRetryFlag,
          reason: !triggerMatched
            ? `trigger not in retry.on [${retryOn.join(", ")}]`
            : is499 && !four99Allowed
              ? `499 suppressed: idempotency="${idempotency}" (non-idempotent; pre-check required)`
              : canRetryFlag
                ? `499 retried (idempotency="${idempotency}")`
                : `max attempts (${maxAttempts}) reached`,
        };
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
        retry: retryCtx,
      });
      stepFailure = res;
      lastFailure = res;

      if (canRetryFlag) {
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
