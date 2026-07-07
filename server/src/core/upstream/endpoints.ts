import { familyForProviderType, type ProviderType } from "../format/family";

/** A materialized provider (decrypted key) ready to be called upstream. */
export interface UpstreamProvider {
  type: ProviderType;
  baseUrl: string;
  apiKey: string | null;
  extraHeaders?: Record<string, string> | null;
}

export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Headers a caller-supplied `extraHeaders` map may not set: hop-by-hop headers
 * and framing/routing headers that must be controlled by the proxy, not by
 * whoever configured the provider.
 */
const BLOCKED_EXTRA_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/** The chat/messages/responses endpoint URL for a provider. */
export function chatUrl(p: UpstreamProvider): string {
  const base = trimBase(p.baseUrl);
  const family = familyForProviderType(p.type);
  if (family === "anthropic") return `${base}/v1/messages`;
  if (family === "openai_responses") return `${base}/responses`;
  return `${base}/chat/completions`;
}

export function embeddingsUrl(p: UpstreamProvider): string {
  return `${trimBase(p.baseUrl)}/embeddings`;
}

export function modelsUrl(p: UpstreamProvider): string {
  const base = trimBase(p.baseUrl);
  return familyForProviderType(p.type) === "anthropic" ? `${base}/v1/models` : `${base}/models`;
}

/**
 * Build the outgoing header set. Custom headers are applied first (hop-by-hop /
 * routing headers stripped, keys lowercased), then the provider's configured
 * auth OVERWRITES any caller-supplied auth so extraHeaders can't inject a second
 * auth header via a case variant.
 */
export function buildHeaders(p: UpstreamProvider, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (p.extraHeaders) {
    for (const [k, v] of Object.entries(p.extraHeaders)) {
      const key = k.toLowerCase();
      if (!BLOCKED_EXTRA_HEADERS.has(key)) headers[key] = v;
    }
  }
  if (familyForProviderType(p.type) === "anthropic") {
    if (p.apiKey) headers["x-api-key"] = p.apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  } else if (p.apiKey) {
    headers["authorization"] = `Bearer ${p.apiKey}`;
  }
  if (extra) for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v;
  return headers;
}
