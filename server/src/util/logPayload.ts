/**
 * Serialize request/response payloads for the log store.
 *
 * The store has a per-row character budget (LOG_PAYLOAD_MAX_CHARS). Naively
 * cutting the serialized JSON string at that budget produces invalid JSON that
 * the log viewer can neither parse into a transcript nor pretty-print — the
 * payload shows up "unformatted". Instead we truncate long *string fields*
 * inside the payload, so the stored JSON stays valid (and therefore
 * formattable) while its size is bounded.
 */

/** Pretty-print for storage; falls back to a string form on error. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Deep-copy `value`, truncating any string longer than `perStringMax`. */
function truncateStrings(value: unknown, perStringMax: number): unknown {
  if (typeof value === "string") {
    return value.length > perStringMax
      ? `${value.slice(0, perStringMax)}... [+${value.length - perStringMax} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, perStringMax));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateStrings(v, perStringMax);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a payload to VALID JSON no longer than ~maxChars. `maxChars <= 0`
 * means unlimited. Oversized payloads keep their structure (every turn is still
 * visible) with long strings shortened; only the pathological case of a huge
 * number of fields falls back to a small valid envelope.
 */
export function serializeForLog(value: unknown, maxChars: number): string {
  const full = safeStringify(value);
  if (maxChars <= 0 || full.length <= maxChars) return full;

  for (
    let perString = Math.max(2000, Math.floor(maxChars / 4));
    perString >= 200;
    perString = Math.floor(perString / 2)
  ) {
    const clamped = safeStringify(truncateStrings(value, perString));
    if (clamped.length <= maxChars) return clamped;
  }

  return safeStringify({
    _truncated: true,
    _originalChars: full.length,
    note: "payload exceeded LOG_PAYLOAD_MAX_CHARS; raise it to capture full payloads",
  });
}
