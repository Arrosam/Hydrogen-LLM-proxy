import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./errors";
import { usePolling } from "./usePolling";

export interface LiveQuery<T> {
  /** The latest answer; kept while a reload is in flight and after a failed one. */
  data: T | null;
  /** True during a non-silent load only. */
  loading: boolean;
  error: string | null;
  /** Fetch again. `silent` leaves `loading` alone (no spinner flicker): what a poll tick does. */
  reload: (silent?: boolean) => void;
  /** For a failure of something beside the list (a detail fetch) shown in the same place. */
  setError: (message: string | null) => void;
}

/**
 * A list that reloads whenever its query changes and, while `live`, silently
 * every `pollMs`. `query` must be memoized (`useCallback`) on the filters it
 * reads: a new identity is what triggers the reload and restarts the timer.
 *
 * Unlike `useAsync` there is no generation guard: answers are applied in
 * arrival order, as the pages that poll always did.
 */
export function useLiveQuery<T>(query: () => Promise<T>, { pollMs, live }: { pollMs: number; live: boolean }): LiveQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    (silent = false) => {
      if (!silent) setLoading(true);
      query()
        .then((r) => {
          setData(r);
          setError(null);
        })
        .catch((e: unknown) => setError(errorMessage(e)))
        .finally(() => {
          if (!silent) setLoading(false);
        });
    },
    [query],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  const refresh = useCallback(() => reload(true), [reload]);
  usePolling(refresh, pollMs, live);

  return { data, loading, error, reload, setError };
}
