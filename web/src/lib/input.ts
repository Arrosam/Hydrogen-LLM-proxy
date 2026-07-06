/** Shared input-field helpers for the editor forms. */

export const selectAll = (e: React.SyntheticEvent<HTMLInputElement>) => e.currentTarget.select();

/** Digits-only text input -> integer clamped to `min`; `fallback` when empty. */
export function intInput(raw: string, fallback: number, min = 0): number {
  const n = Number(raw.replace(/\D/g, ""));
  return Math.max(min, n || fallback);
}
