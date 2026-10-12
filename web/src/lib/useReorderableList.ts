import { useState, type DragEvent } from "react";
import { moveItem, removeAt } from "./collections";
import { useListKeys } from "./useListKeys";

export interface ReorderableList<T> {
  /** Stable React keys, one per item; they travel with their item through every operation below. */
  keys: number[];
  append: (item: T) => void;
  insertAfter: (index: number, item: T) => void;
  /** `commit` replaces the list's own, for a removal that must change something else along with it. */
  remove: (index: number, commit?: (next: T[]) => void) => void;
  /** Props of the element that starts a drag of item `index`. */
  dragHandleProps: (index: number) => { draggable: true; onDragStart: () => void; onDragEnd: () => void };
  /** Props of the element item `index` can be dropped on. */
  dropTargetProps: (index: number) => { onDragOver: (e: DragEvent) => void; onDrop: () => void };
}

/**
 * A positional list the user can append to, duplicate into, remove from and
 * reorder by drag and drop. The list itself stays with the caller (`items` in,
 * `commit(next)` out); the hook owns the keys and the drag in progress.
 */
export function useReorderableList<T>(items: readonly T[], commit: (next: T[]) => void): ReorderableList<T> {
  const keys = useListKeys(items.length);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const drop = (index: number) => {
    // A drop with no drag in progress (it ended, or came from elsewhere) moves nothing.
    if (dragIndex === null || dragIndex === index) return;
    keys.move(dragIndex, index);
    commit(moveItem(items, dragIndex, index));
    setDragIndex(null);
  };

  return {
    keys: keys.keys,
    append(item) {
      keys.insert(items.length);
      commit([...items, item]);
    },
    insertAfter(index, item) {
      keys.insert(index + 1);
      commit([...items.slice(0, index + 1), item, ...items.slice(index + 1)]);
    },
    remove(index, commitWith = commit) {
      keys.remove(index);
      commitWith(removeAt(items, index));
    },
    dragHandleProps: (index) => ({ draggable: true, onDragStart: () => setDragIndex(index), onDragEnd: () => setDragIndex(null) }),
    dropTargetProps: (index) => ({ onDragOver: (e) => e.preventDefault(), onDrop: () => drop(index) }),
  };
}
