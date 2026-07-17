/**
 * Canonical request parameters — the normalized superset of the knobs the three
 * wire formats expose. The proxy carries only this canonical shape internally;
 * a step or stage may override any of it, and each format adapter maps what its
 * provider supports (carrying anything unmapped through `extra`).
 */

/**
 * The wire family a client speaks or an upstream provider expects. There are
 * exactly three, and a provider's type is one of them 1:1 (no separate
 * "openai_compatible": a compatible endpoint is just openai_completion).
 */
export type Family = "openai_completion" | "anthropic" | "openai_responses";

/** Named reasoning-effort levels (OpenAI `reasoning_effort`; mapped to a token
 * budget on Anthropic upstreams). */
export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Extended-thinking configuration, normalized across providers.
 *  - "disabled": force thinking off (and strip any that leaks through)
 *  - "auto" / "enabled": on, let the model decide
 *  - an effort level: on at that effort
 *  - { budget }: on with an explicit thinking-token budget
 */
export type ThinkingLevel = "disabled" | "auto" | "enabled" | EffortLevel | { budget: number };

/** Structured-output request (OpenAI `response_format` / Anthropic tool-forced json). */
export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name?: string; schema: Record<string, unknown>; strict?: boolean };

/**
 * The full set of generation knobs, all optional. Overriding a step/stage may
 * patch any subset of these. Adapters translate the fields their provider
 * supports and pass the rest through `extra`.
 */
export interface GenerationParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  /** Max output tokens (max_tokens / max_completion_tokens / max_output_tokens). */
  maxTokens?: number;
  stop?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  seed?: number;
  /** Number of choices to generate (OpenAI `n`). */
  n?: number;
  logprobs?: boolean;
  topLogprobs?: number;
  logitBias?: Record<string, number>;
  responseFormat?: ResponseFormat;
  parallelToolCalls?: boolean;
  serviceTier?: string;
  /** End-user identifier passed through for provider-side abuse tracking. */
  user?: string;
  /** Output verbosity hint (newer OpenAI models). */
  verbosity?: "low" | "medium" | "high";
  /** Extended thinking / reasoning level. */
  thinking?: ThinkingLevel;
  /** Provider-specific params with no canonical field, passed through verbatim. */
  extra?: Record<string, unknown>;
  /**
   * Params the client sent that no canonical field models, kept verbatim so a
   * request nobody overrode reaches the provider as the client wrote it.
   *
   * Distinct from `extra`, which a step/stage sets deliberately and which
   * therefore applies to any provider: these are the client's own words, so they
   * are replayed only onto `family` — the wire format they were written for.
   */
  passthrough?: { family: Family; params: Record<string, unknown> };
}

/** Every generation param a step/stage is allowed to override. */
export type OverridableParam = keyof GenerationParams;

/**
 * A partial patch a ModelService step or MicroAgent stage applies to the
 * outgoing request. Beyond the generation params it may force the transport
 * mode (a MicroAgent sets `stream: false` for its internal calls) and replace
 * the system prompt. Precedence when resolving a value: override -> the
 * service's own config -> the original client request.
 */
export interface RequestOverrides extends Partial<GenerationParams> {
  stream?: boolean;
  system?: string;
}

/** Merge a patch onto base params, with the patch winning on any present key.
 * The `extra` record (provider-specific nested params) is deep-merged so a
 * nested JSON object override never silently drops the base's keys. */
export function mergeParams(base: GenerationParams, patch?: Partial<GenerationParams>): GenerationParams {
  if (!patch) return base;
  const out: GenerationParams = { ...base };
  for (const key of Object.keys(patch) as OverridableParam[]) {
    const v = patch[key];
    if (v === undefined) continue;
    if (key === "extra" && typeof v === "object" && !Array.isArray(v) && v !== null) {
      const baseExtra = (out.extra ?? {}) as Record<string, unknown>;
      (out as Record<string, unknown>).extra = { ...baseExtra, ...(v as Record<string, unknown>) };
    } else {
      (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}

/**
 * Layer two override patches, with `patch` winning on any present key (undefined
 * values do not clobber). Used to fold an outer agent's overrides over a stage's
 * own config before handing them to the stage's Model Service.
 */
export function mergeOverrides(base?: RequestOverrides, patch?: RequestOverrides): RequestOverrides | undefined {
  if (!base) return patch;
  if (!patch) return base;
  const out: RequestOverrides = { ...base };
  for (const key of Object.keys(patch) as (keyof RequestOverrides)[]) {
    const v = patch[key];
    if (v === undefined) continue;
    if (key === "extra" && typeof v === "object" && !Array.isArray(v) && v !== null) {
      const baseExtra = (out.extra ?? {}) as Record<string, unknown>;
      (out as Record<string, unknown>).extra = { ...baseExtra, ...(v as Record<string, unknown>) };
    } else {
      (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}
