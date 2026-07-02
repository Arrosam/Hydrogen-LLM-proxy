import type { Family, IRRequest, IRResponse } from "../ir";
import type { ClientResponseCtx } from "./openai";
import * as openai from "./openai";
import * as anthropic from "./anthropic";

export type ProviderType = "openai" | "anthropic" | "openai_compatible";

/** OpenAI and OpenAI-compatible upstreams share the OpenAI wire format. */
export function familyForProviderType(t: ProviderType): Family {
  return t === "anthropic" ? "anthropic" : "openai";
}

export interface FormatAdapter {
  requestToIR(body: Record<string, unknown>): IRRequest;
  irToRequest(ir: IRRequest, upstreamModel: string): Record<string, unknown>;
  responseToIR(body: Record<string, unknown>): IRResponse;
  irToResponse(ir: IRResponse, ctx: ClientResponseCtx): Record<string, unknown>;
}

const registry: Record<Family, FormatAdapter> = { openai, anthropic };

export function adapterFor(family: Family): FormatAdapter {
  return registry[family];
}

export { openai, anthropic };
export type { ClientResponseCtx };
