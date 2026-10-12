import type { IncomingHttpHeaders } from "node:http";
import type { Family } from "../core/format/family";
import { HEADER } from "../util/httpHeaders";

/** Client feature headers carried to a same-family upstream. Auth never forwards. */
export const ANTHROPIC_FORWARD_HEADERS: readonly string[] = [HEADER.ANTHROPIC_BETA];
export const OPENAI_FORWARD_HEADERS: readonly string[] = [HEADER.OPENAI_BETA, HEADER.HTTP_REFERER, HEADER.X_TITLE];

/**
 * The allowlisted feature headers (anthropic-beta flags, attribution headers)
 * a client sent, for the request's `forwardHeaders`.
 *
 * The two ingress paths read a header value differently, and each reading is
 * kept: the chat path joins a repeated header and skips an empty value; the
 * stateful Responses path forwards single string values only, empty included.
 */
export function collectForwardHeaders(
  headers: IncomingHttpHeaders,
  family: Family,
  o: { joinRepeated: boolean; keepEmpty: boolean },
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of family === "anthropic" ? ANTHROPIC_FORWARD_HEADERS : OPENAI_FORWARD_HEADERS) {
    const value = headers[name];
    if (typeof value === "string") {
      if (value || o.keepEmpty) forwarded[name] = value;
    } else if (o.joinRepeated && Array.isArray(value) && value.length) {
      forwarded[name] = value.join(",");
    }
  }
  return forwarded;
}
