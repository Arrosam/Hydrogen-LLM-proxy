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

/** Routes a rewrite may land on (the proxy's client-facing API). */
const KNOWN = new Set([
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/responses",
  "/v1/models",
  "/v1/embeddings",
  "/v1/rerank",
  "/v1/images/generations",
  "/v1/videos",
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
]);

/** Path suffix -> canonical route. Longest suffixes first; singular spellings
 * tolerated because that is exactly the kind of typo this exists for. */
const SUFFIXES: Array<[string, string]> = [
  ["/chat/completions", "/v1/chat/completions"],
  ["/chat/completion", "/v1/chat/completions"],
  ["/images/generations", "/v1/images/generations"],
  ["/images/generation", "/v1/images/generations"],
  ["/audio/speech", "/v1/audio/speech"],
  ["/audio/transcriptions", "/v1/audio/transcriptions"],
  ["/audio/transcription", "/v1/audio/transcriptions"],
  // A bare "completions" is either the legacy text endpoint or a missing
  // "chat/" — both mean the chat endpoint here.
  ["/completions", "/v1/chat/completions"],
  ["/completion", "/v1/chat/completions"],
  ["/messages", "/v1/messages"],
  ["/message", "/v1/messages"],
  ["/responses", "/v1/responses"],
  ["/response", "/v1/responses"],
  ["/embeddings", "/v1/embeddings"],
  ["/embedding", "/v1/embeddings"],
  ["/rerank", "/v1/rerank"],
  ["/models", "/v1/models"],
];

function speaksAnthropic(headers: Record<string, string | string[] | undefined>): boolean {
  return headers["anthropic-version"] != null || headers["x-api-key"] != null;
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
  if (path.startsWith("/admin") || path === "/healthz" || /\.[a-zA-Z0-9]+$/.test(path)) {
    return url;
  }
  if (KNOWN.has(path) || path.startsWith("/v1/videos/")) return path + query;

  // Bare base URL: the endpoint was left off entirely. Only a POST carries
  // enough intent to route; sniff the wire family from the headers.
  if (path === "" || path === "/" || path === "/v1" || path === "/api" || path === "/api/v1") {
    if ((method ?? "").toUpperCase() === "POST") {
      return (speaksAnthropic(headers) ? "/v1/messages" : "/v1/chat/completions") + query;
    }
    return url;
  }

  for (const [suffix, canonical] of SUFFIXES) {
    if (path === suffix || path.endsWith(suffix)) return canonical + query;
  }
  return url;
}
