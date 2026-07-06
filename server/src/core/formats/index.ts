import type { Family, IRRequest, IRResponse } from "../ir";
import type { ClientResponseCtx } from "./openai";
import * as openai from "./openai";
import * as anthropic from "./anthropic";
import * as openaiResponses from "./openaiResponses";

export type ProviderType = "openai" | "anthropic" | "openai_compatible" | "openai_responses";

/** OpenAI and OpenAI-compatible upstreams share the Chat Completions format;
 * "openai_responses" providers speak the Responses API. */
export function familyForProviderType(t: ProviderType): Family {
  if (t === "anthropic") return "anthropic";
  if (t === "openai_responses") return "openai_responses";
  return "openai";
}

/** Client-facing translation: parse a request, render a response. */
export interface IngressAdapter {
  requestToIR(body: Record<string, unknown>): IRRequest;
  irToResponse(ir: IRResponse, ctx: ClientResponseCtx): Record<string, unknown>;
}

/** Upstream-facing translation: render a request, parse a response. */
export interface EgressAdapter {
  irToRequest(ir: IRRequest, upstreamModel: string): Record<string, unknown>;
  responseToIR(body: Record<string, unknown>): IRResponse;
}

export interface FormatAdapter extends IngressAdapter, EgressAdapter {}

const registry: Record<Family, FormatAdapter> = {
  openai,
  anthropic,
  openai_responses: openaiResponses,
};

/** Adapter for the format a client speaks. */
export function ingressAdapterFor(family: Family): IngressAdapter {
  return registry[family];
}

/** Adapter for the format an upstream provider speaks. */
export function adapterFor(family: Family): EgressAdapter {
  return registry[family];
}

export { openai, anthropic, openaiResponses };
export type { ClientResponseCtx };
