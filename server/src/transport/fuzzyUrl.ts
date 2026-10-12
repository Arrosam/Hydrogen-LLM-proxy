/**
 * Fuzzy endpoint adapter: clients routinely misconfigure the base URL — a
 * doubled slash (`//v1/messages`), a missing `/v1` (`/completions`), a bare
 * `/v1` with the endpoint left off entirely. Rather than 404 a request whose
 * intent is obvious, rewrite the URL onto the canonical route BEFORE routing.
 *
 * Deliberately conservative:
 *  - a URL that already hits a known route is returned untouched;
 *  - `/admin`, `/healthz`, and asset-looking paths are never rewritten;
 *  - the endpoint is picked from the path's own suffix first, and only a bare
 *    `/`, `/v1` falls back to header sniffing (an `anthropic-version` or
 *    `x-api-key` header means the caller speaks the Anthropic wire).
 */

import { HEADER } from "../util/httpHeaders";
import { ADMIN_PREFIX, API_PREFIX, HEALTH_PATH, ROUTE } from "./routes";

/** Routes a rewrite may land on (the proxy's client-facing API). */
const KNOWN = new Set<string>([
  ROUTE.CHAT_COMPLETIONS,
  ROUTE.MESSAGES,
  ROUTE.RESPONSES,
  ROUTE.MODELS,
  ROUTE.EMBEDDINGS,
  ROUTE.RERANK,
  ROUTE.IMAGE_GENERATIONS,
  ROUTE.VIDEOS,
  ROUTE.AUDIO_SPEECH,
  ROUTE.AUDIO_TRANSCRIPTIONS,
]);

/** Path suffix -> canonical route. Longest suffixes first; singular spellings
 * tolerated because that is exactly the kind of typo this exists for. */
const SUFFIXES: Array<[string, string]> = [
  ["/chat/completions", ROUTE.CHAT_COMPLETIONS],
  ["/chat/completion", ROUTE.CHAT_COMPLETIONS],
  ["/images/generations", ROUTE.IMAGE_GENERATIONS],
  ["/images/generation", ROUTE.IMAGE_GENERATIONS],
  ["/audio/speech", ROUTE.AUDIO_SPEECH],
  ["/audio/transcriptions", ROUTE.AUDIO_TRANSCRIPTIONS],
  ["/audio/transcription", ROUTE.AUDIO_TRANSCRIPTIONS],
  // A bare "completions" is either the legacy text endpoint or a missing
  // "chat/" — both mean the chat endpoint here.
  ["/completions", ROUTE.CHAT_COMPLETIONS],
  ["/completion", ROUTE.CHAT_COMPLETIONS],
  ["/messages", ROUTE.MESSAGES],
  ["/message", ROUTE.MESSAGES],
  ["/responses", ROUTE.RESPONSES],
  ["/response", ROUTE.RESPONSES],
  ["/embeddings", ROUTE.EMBEDDINGS],
  ["/embedding", ROUTE.EMBEDDINGS],
  ["/rerank", ROUTE.RERANK],
  ["/models", ROUTE.MODELS],
];

function speaksAnthropic(headers: Record<string, string | string[] | undefined>): boolean {
  return headers[HEADER.ANTHROPIC_VERSION] != null || headers[HEADER.X_API_KEY] != null;
}

/**
 * Rewrite a sloppy request URL onto its canonical route, or return the input
 * unchanged when it is already routable (or not obviously an API call).
 */
export function fuzzyRewriteUrl(
  method: string | undefined,
  url: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): string {
  if (!url) return "/";
  const q = url.indexOf("?");
  const rawPath = q >= 0 ? url.slice(0, q) : url;
  const query = q >= 0 ? url.slice(q) : "";

  // Normalize: collapse duplicate slashes, drop the trailing slash.
  let path = rawPath.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // Never touch the dashboard, its API, health, or static assets.
  if ((path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`)) || path === HEALTH_PATH || /\.[a-zA-Z0-9]+$/.test(path)) {
    return url;
  }
  if (KNOWN.has(path) || path.startsWith(`${ROUTE.VIDEOS}/`)) return path + query;

  // Bare base URL: the endpoint was left off entirely. Only a POST carries
  // enough intent to route; sniff the wire family from the headers.
  if (path === "" || path === "/" || path === API_PREFIX || path === "/api" || path === "/api/v1") {
    if ((method ?? "").toUpperCase() === "POST") {
      return (speaksAnthropic(headers) ? ROUTE.MESSAGES : ROUTE.CHAT_COMPLETIONS) + query;
    }
    return url;
  }

  for (const [suffix, canonical] of SUFFIXES) {
    if (path === suffix || path.endsWith(suffix)) return canonical + query;
  }
  return url;
}
