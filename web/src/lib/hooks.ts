import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Run the latest loader on mount/reload; only the newest request may publish. */
export function useAsync<T>(fn: () => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loader = useRef(fn);
  loader.current = fn;
  const generation = useRef(0);

  const reload = useCallback(() => {
    const id = ++generation.current;
    const run = loader.current;
    setLoading(true);
    setError(null);
    // Capture this reload's loader, while allowing a synchronous throw to follow
    // the same error path as a rejected promise.
    Promise.resolve().then(run)
      .then((d) => { if (id === generation.current) { setData(d); setError(null); } })
      .catch((e: unknown) => {
        if (id === generation.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (id === generation.current) setLoading(false); });
  }, []);

  useEffect(() => {
    reload();
    return () => { generation.current++; };
  }, [reload]);
  return { data, loading, error, reload };
}
