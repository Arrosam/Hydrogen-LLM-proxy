/**
 * Key/value rows edited as text and sent as an object: the bench's extra
 * request parameters and a service's sampling overrides.
 */

export interface KeyValueRow {
  key: string;
  value: string;
}

export interface CoerceOptions {
  /**
   * Trim the text before reading it, so `" abc "` is `"abc"`. Off, a bare
   * word keeps its edge whitespace (JSON itself ignores it either way).
   */
  trim?: boolean;
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON when it parses, plain text otherwise: `true`, `0.7` and `["a"]` become
 * what they look like, a bare word stays a string, and a quoted value forces a
 * string.
 */
export function coerceJsonish(raw: string, { trim = false }: CoerceOptions = {}): unknown {
  const text = trim ? raw.trim() : raw;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A stored value as the text `coerceJsonish(text, { trim: true })` reads back
 * to it. Strings that would not survive the plain-text round trip -- JSON-
 * parseable, edge whitespace (trimmed on the way in), or embedded newlines (a
 * single-line input strips CR/LF) -- are JSON-quoted.
 */
export function jsonishText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    const fragile = value !== value.trim() || /[\r\n]/.test(value) || parsesAsJson(value);
    return fragile ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value);
}

export interface RowsToObjectOptions extends CoerceOptions {
  /** Leave out a row whose value is empty (after trimming, with `trim`). Off, it is sent as `""`. */
  dropEmpty?: boolean;
}

/**
 * The object the rows spell. Keys are always trimmed and a row without a key
 * is skipped; on a repeated key the last row wins.
 */
export function rowsToObject(rows: readonly KeyValueRow[], { trim = false, dropEmpty = false }: RowsToObjectOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (dropEmpty && (trim ? row.value.trim() : row.value) === "") continue;
    out[key] = coerceJsonish(row.value, { trim });
  }
  return out;
}

/** One row per entry, values as `jsonishText` writes them. */
export function objectToRows(object: Record<string, unknown> | undefined): KeyValueRow[] {
  return Object.entries(object ?? {}).map(([key, value]) => ({ key, value: jsonishText(value) }));
}

/** How many rows use each (trimmed, non-empty) key: more than one is a duplicate. */
export function keyCounts(rows: readonly KeyValueRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
