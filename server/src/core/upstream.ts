import { request } from "undici";
import type { Readable } from "node:stream";
import { familyForProviderType, type ProviderType } from "./formats";

export interface UpstreamProvider {
  type: ProviderType;
  baseUrl: string;
  apiKey: string | null;
  extraHeaders?: Record<string, string> | null;
}

export interface UpstreamCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export const ANTHROPIC_VERSION = "2023-06-01";

function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

export function chatUrl(p: UpstreamProvider): string {
  const base = trimBase(p.baseUrl);
  return familyForProviderType(p.type) === "anthropic"
    ? `${base}/v1/messages`
    : `${base}/chat/completions`;
}

export function embeddingsUrl(p: UpstreamProvider): string {
  return `${trimBase(p.baseUrl)}/embeddings`;
}

export function modelsUrl(p: UpstreamProvider): string {
  const base = trimBase(p.baseUrl);
  return familyForProviderType(p.type) === "anthropic" ? `${base}/v1/models` : `${base}/models`;
}

export function buildHeaders(p: UpstreamProvider, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (familyForProviderType(p.type) === "anthropic") {
    if (p.apiKey) headers["x-api-key"] = p.apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  } else if (p.apiKey) {
    headers["authorization"] = `Bearer ${p.apiKey}`;
  }
  if (p.extraHeaders) Object.assign(headers, p.extraHeaders);
  if (extra) Object.assign(headers, extra);
  return headers;
}

function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  // Node >= 20.3 has AbortSignal.any
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return anyFn ? anyFn([timeout, external]) : timeout;
}

export interface UpstreamJsonResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: unknown;
  text: string;
}

/** POST a JSON body and read the full JSON (or text) response. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: UpstreamCallOptions,
): Promise<UpstreamJsonResult> {
  const res = await request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: combineSignals(opts.timeoutMs, opts.signal),
  });
  const text = await res.body.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, headers: res.headers, json, text };
}

export interface UpstreamStreamResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

/**
 * POST a JSON body and return the raw response stream (for SSE translation).
 * The timeout bounds time-to-response-headers only; the body may then stream for
 * as long as it needs (bodyTimeout disabled) so long completions aren't cut off.
 */
export async function postStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: UpstreamCallOptions,
): Promise<UpstreamStreamResult> {
  const res = await request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
    headersTimeout: opts.timeoutMs,
    bodyTimeout: 0,
  });
  return { status: res.statusCode, headers: res.headers, body: res.body as unknown as Readable };
}

/** GET request returning JSON (used for provider connection tests / model lists). */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  opts: UpstreamCallOptions,
): Promise<UpstreamJsonResult> {
  const res = await request(url, {
    method: "GET",
    headers,
    signal: combineSignals(opts.timeoutMs, opts.signal),
  });
  const text = await res.body.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, headers: res.headers, json, text };
}
