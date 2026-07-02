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

// Object keys whose value is a credential, not content — redacted before a
// payload is ever written to the log store.
const REDACT_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "api-key",
  "x-api-key",
  "x_api_key",
  "access_token",
  "secret",
  "password",
]);

/** Deep-copy `value`, replacing values of credential-named keys with a marker. */
function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[redacted]" : redactSensitive(v);
    }
    return out;
  }
  return value;
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
  const redacted = redactSensitive(value);
  const full = safeStringify(redacted);
  if (maxChars <= 0 || full.length <= maxChars) return full;

  let prevLen = Infinity;
  for (
    let perString = Math.max(2000, Math.floor(maxChars / 4));
    perString >= 200;
    perString = Math.floor(perString / 2)
  ) {
    const clamped = safeStringify(truncateStrings(redacted, perString));
    if (clamped.length <= maxChars) return clamped;
    // Size comes from many fields, not long strings — shrinking has plateaued,
    // so stop wasting deep-copy passes and fall through to the envelope.
    if (clamped.length >= prevLen) break;
    prevLen = clamped.length;
  }

  const envelope = safeStringify({
    _truncated: true,
    _originalChars: full.length,
    note: "payload exceeded LOG_PAYLOAD_MAX_CHARS; raise it to capture full payloads",
  });
  // Honour the budget even for an absurdly small maxChars (< the envelope).
  return envelope.length <= maxChars ? envelope : full.slice(0, maxChars);
}
