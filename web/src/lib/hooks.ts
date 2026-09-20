import { useCallback, useEffect, useRef, useState } from "react";

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
      .catch((e: unknown) => { if (id === generation.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (id === generation.current) setLoading(false); });
  }, []);
  useEffect(() => { reload(); return () => { generation.current++; }; }, [reload]);
  return { data, loading, error, reload };
}
