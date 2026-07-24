import { useRef } from "react";

/**
 * Stable React keys for a positional list whose items carry no natural id
 * (steps, stages, override rows). Index keys make React rebind a mounted
 * subtree to a DIFFERENT item after a mid-list insert/remove/reorder, leaking
 * uncontrolled state (focus, IME composition, draft rows) across items.
 *
 * Call the mutators alongside the matching list-state update so keys travel
 * with their items. A length mismatch at render time (an external reset, e.g.
 * loading a definition) regenerates every key, deliberately remounting the
 * list so no stale local state survives.
 */
export function useListKeys(length: number): {
  keys: number[];
  insert: (at: number) => void;
  remove: (at: number) => void;
  move: (from: number, to: number) => void;
} {
  const nextId = useRef(1);
  const ids = useRef<number[]>([]);
  if (ids.current.length !== length) {
    ids.current = Array.from({ length }, () => nextId.current++);
  }
  return {
    keys: ids.current,
    insert(at: number) {
      ids.current = [...ids.current.slice(0, at), nextId.current++, ...ids.current.slice(at)];
    },
    remove(at: number) {
      ids.current = ids.current.filter((_, i) => i !== at);
    },
    move(from: number, to: number) {
      const next = [...ids.current];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      ids.current = next;
    },
  };
}
