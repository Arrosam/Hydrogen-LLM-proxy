/** Small immutable list operations the forms and editors repeat. */

/** `list` with `value` present or absent, as a checkbox reports it. */
export const setMember = <T,>(list: readonly T[], value: T, present: boolean): T[] =>
  present ? [...list, value] : list.filter((x) => x !== value);

/** `list` with `value` flipped: removed when present, appended when not. */
export const toggleMember = <T,>(list: readonly T[] | undefined, value: T): T[] => {
  const current = list ?? [];
  return current.includes(value) ? current.filter((x) => x !== value) : [...current, value];
};

/** `list` with the item at `from` moved to `to`. */
export const moveItem = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

/** `list` with the item at `index` replaced by `patch` merged over it. */
export const patchAt = <T extends object>(list: readonly T[], index: number, patch: Partial<T>): T[] =>
  list.map((item, i) => (i === index ? { ...item, ...patch } : item));

/** `list` with the item at `index` replaced by `item`. */
export const replaceAt = <T,>(list: readonly T[], index: number, item: T): T[] => list.map((x, i) => (i === index ? item : x));

/** `list` without the item at `index`. */
export const removeAt = <T,>(list: readonly T[], index: number): T[] => list.filter((_, i) => i !== index);

/** The name of the list entry with this id, or "#id" when it is not (or no longer) there. */
export const nameById = (list: readonly { id: number; name: string }[] | undefined, id: number): string =>
  list?.find((x) => x.id === id)?.name ?? `#${id}`;
