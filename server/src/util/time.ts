/** Coerce a drizzle timestamp value (Date in JS, integer in SQLite) to epoch ms. */
export function asMillis(v: Date | number): number {
  return v instanceof Date ? v.getTime() : Number(v);
}

export function asMillisOrNull(v: Date | number | null): number | null {
  return v == null ? null : asMillis(v);
}

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
