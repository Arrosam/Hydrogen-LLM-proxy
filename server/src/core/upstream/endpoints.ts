import { familyForProviderType, type ProviderType } from "../format/family";
import type { EgressProxy } from "./egress/types";

/** A materialized provider (decrypted key) ready to be called upstream. */
export interface UpstreamProvider {
  type: ProviderType;
  baseUrl: string;
  apiKey: string | null;
  extraHeaders?: Record<string, string> | null;
  /**
   * Send this provider's traffic through a proxy instead of connecting
   * directly. Absent/null = direct, which is what every provider does unless
   * an admin attached one.
   *
   * It lives here because this interface is already "the provider, resolved
   * for making a call" -- the same object that carries the decrypted key and
   * the extra headers. Every path that reaches an upstream already carries one,
   * so the proxy reaches the socket by the route provider identity already
   * travels rather than by a second one threaded alongside it.
   */
  proxy?: EgressProxy | null;
}

export const ANTHROPIC_VERSION = "2023-06-01";

/** One endpoint a provider serves, with its position in the provider's list. */
export interface ProviderEndpoint {
  /** 0 = the primary endpoint, 1..n = the declared alternates, in order. The
   * index is stable for a given provider row, so it can be handed to a client
   * (video job ids) and resolved back to the same endpoint on a later request. */
  index: number;
  type: ProviderType;
  baseUrl: string;
}

/** Every endpoint a provider serves: its primary first, then its alternates. */
export function providerEndpoints(p: {
  type: ProviderType;
  baseUrl: string;
  altEndpoints?: Array<{ type: ProviderType; baseUrl: string }> | null;
}): ProviderEndpoint[] {
  return [
    { index: 0, type: p.type, baseUrl: p.baseUrl },
    ...(p.altEndpoints ?? []).map((e, i) => ({ index: i + 1, type: e.type, baseUrl: e.baseUrl })),
  ];
}

/**
 * The media/passthrough surface (`/embeddings`, `/images/generations`, `/images/edits`,
 * `/audio/*`, `/rerank`, `/videos`) uses JSON/Bearer endpoints under the
 * provider's base URL. The Jev/Laya `/systemone` surface uses the same routing
 * and authentication convention, but its own typed-decision body, not chat.
 * Both OpenAI provider types can route these passthroughs; Anthropic cannot.
 */
export function servesOpenAiMedia(t: ProviderType): boolean {
  return familyForProviderType(t) !== "anthropic";
}

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

function endpointUrl(base: string, suffix: string): string {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/+$/, "") + suffix;
  return url.toString();
}

/** The chat/messages/responses endpoint URL for a provider. */
export function chatUrl(p: UpstreamProvider): string {
  const family = familyForProviderType(p.type);
  return endpointUrl(p.baseUrl, family === "anthropic" ? "/v1/messages" : family === "openai_responses" ? "/responses" : "/chat/completions");
}

export function embeddingsUrl(p: UpstreamProvider): string {
  return endpointUrl(p.baseUrl, "/embeddings");
}

/** OpenAI-style media endpoints (non-chat service categories). */
export function imagesUrl(p: UpstreamProvider, operation: "generations" | "edits" = "generations"): string {
  return endpointUrl(p.baseUrl, `/images/${operation}`);
}

export function speechUrl(p: UpstreamProvider): string {
  return endpointUrl(p.baseUrl, "/audio/speech");
}

export function transcriptionsUrl(p: UpstreamProvider): string {
  return endpointUrl(p.baseUrl, "/audio/transcriptions");
}

/** Jina/Cohere-compatible rerank endpoint. */
export function rerankUrl(p: UpstreamProvider): string {
  return endpointUrl(p.baseUrl, "/rerank");
}

/** Jev / Laya typed semantic decisions. `/batch` is a Laya extension. */
export function systemOneUrl(p: UpstreamProvider, suffix: "" | "/batch" = ""): string {
  return endpointUrl(p.baseUrl, `/systemone${suffix}`);
}

export function videosUrl(p: UpstreamProvider, suffix = ""): string {
  return endpointUrl(p.baseUrl, `/videos${suffix}`);
}

export function modelsUrl(p: UpstreamProvider): string {
  return endpointUrl(p.baseUrl, familyForProviderType(p.type) === "anthropic" ? "/v1/models" : "/models");
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
