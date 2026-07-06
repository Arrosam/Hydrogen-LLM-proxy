import type { EgressFamily, Family, IRRequest, IRResponse } from "../ir";
import type { ClientResponseCtx } from "./openai";
import * as openai from "./openai";
import * as anthropic from "./anthropic";
import * as openaiResponses from "./openaiResponses";

export type ProviderType = "openai" | "anthropic" | "openai_compatible";

/** OpenAI and OpenAI-compatible upstreams share the OpenAI wire format. */
export function familyForProviderType(t: ProviderType): EgressFamily {
  return t === "anthropic" ? "anthropic" : "openai";
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

const ingressRegistry: Record<Family, IngressAdapter> = {
  openai,
  anthropic,
  openai_responses: openaiResponses,
};

const egressRegistry: Record<EgressFamily, EgressAdapter> = { openai, anthropic };

/** Adapter for the format a client speaks (openai, anthropic, openai_responses). */
export function ingressAdapterFor(family: Family): IngressAdapter {
  return ingressRegistry[family];
}

/** Adapter for the format an upstream provider speaks (openai, anthropic). */
export function adapterFor(family: EgressFamily): EgressAdapter {
  return egressRegistry[family];
}

export { openai, anthropic, openaiResponses };
export type { ClientResponseCtx };
