import { MS_PER_MINUTE } from "./constants";

/** Length of "YYYY-MM-DDTHH:mm", the precision a datetime-local input holds. */
const DATETIME_LOCAL_LENGTH = 16;

/** Convert epoch ms to a value suitable for <input type="datetime-local">. */
export function msToLocalInput(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const off = d.getTimezoneOffset();
  return new Date(ms - off * MS_PER_MINUTE).toISOString().slice(0, DATETIME_LOCAL_LENGTH);
}

/**
 * The expiry a form field stands for: `null` when it is empty (never expires),
 * `undefined` when its text is not a date at all -- which must be refused, not
 * saved, since an unparsable date would otherwise serialise to "never".
 * Keeps sub-minute precision when the user leaves the displayed value unchanged.
 */
export function editedExpiry(input: string, original?: number | null): number | null | undefined {
  if (input === msToLocalInput(original)) return original ?? null;
  if (!input) return null;
  const ms = new Date(input).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}
