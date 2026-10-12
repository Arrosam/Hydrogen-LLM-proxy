import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toast";
import { copyToClipboard } from "./clipboard";
import { apiErrorMessage, errorMessage } from "./errors";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Run an async loader on mount and expose a reload(). */
export function useAsync<T>(fn: () => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loader = useRef(fn);
  loader.current = fn;
  const generation = useRef(0);
  const reload = useCallback(() => {
    const id = ++generation.current;
    setLoading(true);
    Promise.resolve().then(() => loader.current())
      .then(d => { if (id === generation.current) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (id === generation.current) setError(errorMessage(e)); })
      .finally(() => { if (id === generation.current) setLoading(false); });
  }, []);
  useEffect(() => { reload(); return () => { generation.current++; }; }, [reload]);
  return { data, loading, error, reload };
}

export interface AttemptOptions {
  /** Where a failure's message goes. Default: an error toast. */
  onError?: (message: string) => void;
  /** Turns the thrown value into display text. Default: `apiErrorMessage`
   * (the server's message, else the fallback). */
  describe?: (e: unknown, fallback: string) => string;
}

/** `fn` with its failure reported; resolves to whether it succeeded. */
export type Attempt = (fn: () => Promise<void>, fallback?: string, onError?: (message: string) => void) => Promise<boolean>;

/**
 * try / catch / report, without a busy flag: for one-shot actions (a row
 * toggle, a delete) that disable nothing while they run.
 */
export function useAttempt(opts: AttemptOptions = {}): Attempt {
  const toast = useToast();
  return async (fn, fallback = "", onError) => {
    try {
      await fn();
      return true;
    } catch (e) {
      (onError ?? opts.onError ?? toast.error)((opts.describe ?? apiErrorMessage)(e, fallback));
      return false;
    }
  };
}

export interface Action {
  /** True while a `run` is in flight. */
  busy: boolean;
  run: Attempt;
}

/**
 * The busy-flag form of `useAttempt`: `busy` is raised for the duration of
 * `run`. Validate BEFORE calling `run`, so a rejected form never flashes its
 * button disabled. Two actions that must lock each other out share one
 * `useAction`.
 */
export function useAction(opts: AttemptOptions = {}): Action {
  const attempt = useAttempt(opts);
  const [busy, setBusy] = useState(false);
  const run: Attempt = async (fn, fallback, onError) => {
    setBusy(true);
    try {
      return await attempt(fn, fallback, onError);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export type Copy = (text: string) => Promise<boolean>;

export interface CopyOptions {
  /**
   * Toast `ok` whether or not the copy worked. This is ModelBench's known
   * defect (a failed copy still says "Copied"), spelled out so that it is kept
   * on purpose until the owner decides; nothing else should pass it.
   */
  successOnFailure: true;
}

/** Copy text to the clipboard and toast the outcome. Resolves to whether it worked. */
export function useCopy(messages: { ok: string; fail: string }): Copy;
export function useCopy(messages: { ok: string }, opts: CopyOptions): Copy;
export function useCopy(messages: { ok: string; fail?: string }, opts?: CopyOptions): Copy {
  const toast = useToast();
  return async (text) => {
    const ok = await copyToClipboard(text);
    if (ok || opts?.successOnFailure) toast.success(messages.ok);
    else toast.error(messages.fail ?? "");
    return ok;
  };
}
