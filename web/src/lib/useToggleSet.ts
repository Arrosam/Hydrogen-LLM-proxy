import { useCallback, useState } from "react";

/** A set of open/selected keys with a flip for one member (expanded table rows). */
export function useToggleSet<T>(): [ReadonlySet<T>, (value: T) => void] {
  const [members, setMembers] = useState<Set<T>>(new Set());
  const toggle = useCallback(
    (value: T): void =>
      setMembers((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      }),
    [],
  );
  return [members, toggle];
}
