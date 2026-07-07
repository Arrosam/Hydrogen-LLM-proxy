/** Header names whose value is a credential; replaced before a log is written. */
const REDACT_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "api-key",
]);

/**
 * Lowercase and redact credential headers, flattening array values. Used to
 * capture the full HTTP request/response headers in the log while never storing
 * the client token or provider key.
 */
export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    const val = Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
    out[key] = REDACT_HEADERS.has(key) ? "[redacted]" : val;
  }
  return out;
}
