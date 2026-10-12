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

import { HEADER } from "./httpHeaders";

/** Pretty-print for storage; falls back to a string form on error. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** What a redacted credential is replaced with, in payloads and in headers. */
export const REDACTED_MARKER = "[redacted]";

/**
 * Per-string budgets tried when a payload is over its limit: start at a
 * quarter of the limit (at least PER_STRING_START_MIN), halve down to
 * PER_STRING_FLOOR; the slim form allows an eighth (at least SLIM_PER_STRING_MIN).
 */
const PER_STRING_START_MIN = 2000;
const PER_STRING_START_DIVISOR = 4;
const PER_STRING_FLOOR = 200;
const SLIM_PER_STRING_MIN = 400;
const SLIM_PER_STRING_DIVISOR = 8;

/** Top-level arrays replaced by a size note in the slim form. */
const BULKY_KEYS = new Set(["messages", "input", "content", "choices", "tools"]);

// Object keys whose value is a credential, not content — redacted before a
// payload is ever written to the log store.
const REDACT_KEYS = new Set<string>([
  HEADER.AUTHORIZATION,
  "api_key",
  "apikey",
  "api-key",
  HEADER.X_API_KEY,
  "x_api_key",
  "access_token",
  "secret",
  "password",
]);

/** What a reference back to one of its own ancestors is replaced with. */
const CIRCULAR_MARKER = "[circular]";

/**
 * Deep-copy `value`, replacing values of credential-named keys with a marker.
 *
 * `ancestors` holds the containers on the path to `value`, so a cyclic payload
 * (only a programmatic caller can build one) ends at a marker instead of
 * recursing until the stack overflows. The copy is therefore always a tree,
 * which is what everything downstream of it walks.
 */
function redactSensitive(value: unknown, ancestors: Set<object> = new Set()): unknown {
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) return CIRCULAR_MARKER;
  ancestors.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => redactSensitive(v, ancestors));
  } else {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      copy[k] = REDACT_KEYS.has(k.toLowerCase()) ? REDACTED_MARKER : redactSensitive(v, ancestors);
    }
    out = copy;
  }
  ancestors.delete(value);
  return out;
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
    let perString = Math.max(PER_STRING_START_MIN, Math.floor(maxChars / PER_STRING_START_DIVISOR));
    perString >= PER_STRING_FLOOR;
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
    const slim: Record<string, unknown> = { _truncated: true, _approxOriginalChars: approxChars };
    for (const [k, v] of Object.entries(redacted as Record<string, unknown>)) {
      slim[k] = BULKY_KEYS.has(k) && Array.isArray(v) ? `[${v.length} item(s) omitted; ~${approxChars} chars total]` : v;
    }
    const clamped = safeStringify(truncateStrings(slim, Math.max(SLIM_PER_STRING_MIN, Math.floor(maxChars / SLIM_PER_STRING_DIVISOR))));
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
