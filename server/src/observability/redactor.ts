import { HEADER } from "../util/httpHeaders";
import { REDACTED_MARKER } from "../util/logPayload";

/** Header names whose value is a credential; replaced before a log is written. */
const REDACT_HEADERS = new Set<string>([
  HEADER.AUTHORIZATION,
  HEADER.X_API_KEY,
  HEADER.COOKIE,
  HEADER.SET_COOKIE,
  HEADER.PROXY_AUTHORIZATION,
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
    out[key] = REDACT_HEADERS.has(key) ? REDACTED_MARKER : val;
  }
  return out;
}
