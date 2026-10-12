import { familyForProviderType, type Family, type ProviderType } from "../format/family";
import type { EgressProxy } from "./egress/types";
import { HEADER, MIME } from "../../util/httpHeaders";

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

/**
 * What differs between the wire families when calling an upstream. A
 * `Record<Family, ...>`, so a new family states its own paths and auth instead
 * of silently falling through to another's.
 */
const FAMILY_UPSTREAM: Record<Family, {
  /** Path of the chat endpoint under the base URL. */
  chatPath: string;
  /** Path of the model listing under the base URL. */
  modelsPath: string;
  /** Whether the OpenAI-shaped media/passthrough surface exists under the base URL. */
  openAiMedia: boolean;
  /** Write the provider's auth (and any version header the family requires) onto the outgoing headers. */
  applyAuth(headers: Record<string, string>, apiKey: string | null): void;
}> = {
  openai_completion: { chatPath: "/chat/completions", modelsPath: "/models", openAiMedia: true, applyAuth: bearerAuth },
  openai_responses: { chatPath: "/responses", modelsPath: "/models", openAiMedia: true, applyAuth: bearerAuth },
  anthropic: {
    chatPath: "/v1/messages",
    modelsPath: "/v1/models",
    openAiMedia: false,
    applyAuth(headers, apiKey) {
      if (apiKey) headers[HEADER.X_API_KEY] = apiKey;
      headers[HEADER.ANTHROPIC_VERSION] = ANTHROPIC_VERSION;
    },
  },
};

function bearerAuth(headers: Record<string, string>, apiKey: string | null): void {
  if (apiKey) headers[HEADER.AUTHORIZATION] = `Bearer ${apiKey}`;
}

/** A type outside the three (bad stored data) keeps reading as Chat Completions, as it always has. */
function familyUpstream(t: ProviderType): (typeof FAMILY_UPSTREAM)[Family] {
  return FAMILY_UPSTREAM[familyForProviderType(t)] ?? FAMILY_UPSTREAM.openai_completion;
}

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
 * The media/passthrough surface (`/embeddings`, `/images/generations`,
 * `/audio/*`, `/rerank`, `/videos`) is OpenAI-shaped, and both OpenAI families
 * expose it at the same paths under their own base URL. Anthropic has no such
 * surface at all.
 */
export function servesOpenAiMedia(t: ProviderType): boolean {
  return familyUpstream(t).openAiMedia;
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

/** `path` under a provider's base URL, whose trailing slashes are not part of it. */
function endpointUrl(p: UpstreamProvider, path: string): string {
  return `${p.baseUrl.replace(/\/+$/, "")}${path}`;
}

/** The chat/messages/responses endpoint URL for a provider. */
export function chatUrl(p: UpstreamProvider): string {
  return endpointUrl(p, familyUpstream(p.type).chatPath);
}

export function embeddingsUrl(p: UpstreamProvider): string {
  return endpointUrl(p, "/embeddings");
}

/** OpenAI-style media endpoints (non-chat service categories). */
export function imagesUrl(p: UpstreamProvider): string {
  return endpointUrl(p, "/images/generations");
}

export function speechUrl(p: UpstreamProvider): string {
  return endpointUrl(p, "/audio/speech");
}

export function transcriptionsUrl(p: UpstreamProvider): string {
  return endpointUrl(p, "/audio/transcriptions");
}

/** Jina/Cohere-compatible rerank endpoint. */
export function rerankUrl(p: UpstreamProvider): string {
  return endpointUrl(p, "/rerank");
}

export function videosUrl(p: UpstreamProvider, suffix = ""): string {
  return endpointUrl(p, `/videos${suffix}`);
}

export function modelsUrl(p: UpstreamProvider): string {
  return endpointUrl(p, familyUpstream(p.type).modelsPath);
}

/**
 * Build the outgoing header set. Custom headers are applied first (hop-by-hop /
 * routing headers stripped, keys lowercased), then the provider's configured
 * auth OVERWRITES any caller-supplied auth so extraHeaders can't inject a second
 * auth header via a case variant.
 */
export function buildHeaders(p: UpstreamProvider, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { [HEADER.CONTENT_TYPE]: MIME.JSON };
  if (p.extraHeaders) {
    for (const [k, v] of Object.entries(p.extraHeaders)) {
      const key = k.toLowerCase();
      if (!BLOCKED_EXTRA_HEADERS.has(key)) headers[key] = v;
    }
  }
  familyUpstream(p.type).applyAuth(headers, p.apiKey);
  if (extra) for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v;
  return headers;
}
