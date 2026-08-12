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
 * A LOWER BOUND on the serialized length, computed by walking the value instead
 * of building the string. Stops once `stopAfter` is passed.
 *
 * It deliberately undercounts — no indentation, no escapes, one char for every
 * primitive — so exceeding the budget is never a false positive. A payload that
 * would have fit therefore still takes the exact path it took before, and is
 * stored byte for byte as it was.
 */
function approxLength(value: unknown, stopAfter = Infinity): number {
  let n = 0;
  const walk = (v: unknown): boolean => {
    if (n > stopAfter) return true;
    if (typeof v === "string") {
      n += v.length + 2; // quotes; any escaping only adds
      return n > stopAfter;
    }
    if (Array.isArray(v)) {
      n += 2;
      for (const x of v) if (walk(x)) return true;
      return n > stopAfter;
    }
    if (v !== null && typeof v === "object") {
      n += 2;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        n += k.length + 3; // "key":
        if (walk(x)) return true;
      }
      return n > stopAfter;
    }
    n += 1; // number / boolean / null / undefined, all at least one char
    return n > stopAfter;
  };
  walk(value);
  return n;
}

/**
 * Serialize a payload to VALID JSON no longer than ~maxChars. `maxChars <= 0`
 * means unlimited. Oversized payloads keep their structure (every turn is still
 * visible) with long strings shortened; only the pathological case of a huge
 * number of fields falls back to a small valid envelope.
 *
 * The size is ESTIMATED before anything is built. Pretty-printing the whole
 * payload merely to discover it was too large used to be the largest transient
 * allocation on the serving path — a 1.5 MB request body produced a >1.5 MB
 * string that was immediately discarded, and a Micro Agent repeats that once per
 * stage, so the waste scaled with stage count.
 */
export function serializeForLog(value: unknown, maxChars: number): string {
  const redacted = redactSensitive(value);
  if (maxChars <= 0) return safeStringify(redacted);

  if (approxLength(redacted, maxChars) <= maxChars) {
    // Only now is building it worth the memory: it almost certainly fits, and
    // the length check below still guards the estimate's blind spots
    // (indentation, escapes).
    const full = safeStringify(redacted);
    if (full.length <= maxChars) return full;
  }

  let prevLen = Infinity;
  for (
    let perString = Math.max(2000, Math.floor(maxChars / 4));
    perString >= 200;
    perString = Math.floor(perString / 2)
  ) {
    const clamped = safeStringify(truncateStrings(redacted, perString));
    if (clamped.length <= maxChars) return clamped;
    // Size comes from many fields, not long strings — shrinking has plateaued,
    // so stop wasting deep-copy passes and fall through to the slim form.
    if (clamped.length >= prevLen) break;
    prevLen = clamped.length;
  }

  // Still too large: the bulk is the conversation itself. Keep every small
  // config field (model, thinking, reasoning_effort, max_tokens, ...) visible
  // and replace only the bulky arrays with a size note, so overrides can still
  // be inspected in the log even for a huge request.
  // The reported original size is the walked lower bound rather than an exact
  // character count: knowing it exactly would mean building the very string this
  // function exists to avoid. It is named so nobody reads it as exact.
  const approxChars = approxLength(redacted);

  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    const BULKY = new Set(["messages", "input", "content", "choices", "tools"]);
    const slim: Record<string, unknown> = { _truncated: true, _approxOriginalChars: approxChars };
    for (const [k, v] of Object.entries(redacted as Record<string, unknown>)) {
      slim[k] = BULKY.has(k) && Array.isArray(v) ? `[${v.length} item(s) omitted; ~${approxChars} chars total]` : v;
    }
    const clamped = safeStringify(truncateStrings(slim, Math.max(400, Math.floor(maxChars / 8))));
    if (clamped.length <= maxChars) return clamped;
  }

  const envelope = safeStringify({
    _truncated: true,
    _approxOriginalChars: approxChars,
    note: "payload exceeded LOG_PAYLOAD_MAX_CHARS; raise it to capture full payloads",
  });
  // Honour the budget even for an absurdly small maxChars (< the envelope). A
  // prefix of the marker beats a prefix of the payload: it cannot be mistaken
  // for the real content, and it does not require building that content.
  return envelope.length <= maxChars ? envelope : envelope.slice(0, maxChars);
}
