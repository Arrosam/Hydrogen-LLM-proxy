/** Convert epoch ms to a value suitable for <input type="datetime-local">. */
export function msToLocalInput(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const off = d.getTimezoneOffset();
  return new Date(ms - off * 60000).toISOString().slice(0, 16);
}

/** Keep sub-minute precision when the user leaves the displayed value unchanged. */
export function editedExpiry(input: string, original?: number | null): number | null {
  return input === msToLocalInput(original) ? original ?? null : input ? new Date(input).getTime() : null;
}
