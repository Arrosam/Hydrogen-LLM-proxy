import { useEffect } from "react";

/** Resolve after `ms`. */
export const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Call `tick` every `intervalMs` for as long as `enabled` holds and the
 * component is mounted. The first call comes one interval after the timer
 * starts: load once yourself if you need a value at once.
 *
 * The timer restarts whenever `tick` changes identity, so pass a memoised
 * callback (`useCallback`) whose dependencies are exactly the things a change
 * of which should restart the cycle (a filter, the key being watched).
 */
export function usePolling(tick: () => void, intervalMs: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [tick, intervalMs, enabled]);
}

export interface PollUntilOptions {
  /** Wait this long before the first attempt (a server that is still shutting down). */
  graceMs?: number;
  /** Pause after a failed attempt. */
  intervalMs: number;
  /** Stop trying this long after the first attempt was due. */
  deadlineMs: number;
}

/**
 * Keep calling `attempt` until it resolves or the deadline passes. A rejected
 * attempt is not an error here, only "not yet": it is swallowed and retried.
 * Resolves to `{ value }` on the first success and to `null` on a timeout.
 */
export async function pollUntil<T>(attempt: () => Promise<T>, { graceMs = 0, intervalMs, deadlineMs }: PollUntilOptions): Promise<{ value: T } | null> {
  if (graceMs > 0) await sleep(graceMs);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      return { value: await attempt() };
    } catch {
      await sleep(intervalMs);
    }
  }
  return null;
}
