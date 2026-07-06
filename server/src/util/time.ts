/** Coerce a drizzle timestamp value (Date in JS, integer in SQLite) to epoch ms. */
export function asMillis(v: Date | number): number {
  return v instanceof Date ? v.getTime() : Number(v);
}

export function asMillisOrNull(v: Date | number | null): number | null {
  return v == null ? null : asMillis(v);
}
