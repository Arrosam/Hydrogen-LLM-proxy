import type { EffortLevel, ThinkingLevel } from "./params";

/**
 * Maps the canonical extended-thinking level onto each wire family's own knob.
 *
 * There is little left to map. All three families express depth as a named
 * effort on a shared scale -- OpenAI's `reasoning_effort`, Responses'
 * `reasoning.effort`, Anthropic's `output_config.effort` -- so the level a
 * caller asked for is the level that goes out, verbatim, on all three.
 *
 * Nothing here rewrites `max_tokens` either. It used to have to: reasoning was
 * billed inside the output ceiling as an explicit `budget_tokens`, so thinking a
 * step imposed meant growing the ceiling to hold a thought the client had not
 * budgeted for, and a ceiling too small to hold one meant lowering the effort or
 * dropping the thinking outright. A named effort is a hint the model paces
 * itself against, not tokens the API sets aside, so none of that arithmetic has
 * anything left to compute. The client's ceiling is the client's ceiling; a
 * provider's hard cap is the only thing that bounds it.
 *
 * Do not reintroduce either. Growing the ceiling spends tokens the caller never
 * agreed to; lowering the effort answers at a level nobody asked for. An upstream
 * that refuses a level refuses it out loud and the error reaches the client --
 * and a user who wants degradation configures it, with a Model Services fallback
 * step carrying a `thinking` override.
 *
 * The same rule covers the ceiling itself. `max_tokens` is REQUIRED on the
 * Anthropic wire and optional on the OpenAI ones, so a client that omits it and
 * lands on an Anthropic upstream produces a request that upstream will reject.
 * This policy does not paper over that with a number of its own -- an invented
 * ceiling silently truncates an answer at a length nobody chose, and the caller
 * has no way to know it happened. The 400 names the missing field; a number
 * would name nothing.
 */

/**
 * Anthropic's own effort scale. Hydrogen carries one extra rung at the bottom --
 * `minimal`, an OpenAI level -- which folds onto `low`.
 */
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
const TO_ANTHROPIC_EFFORT: Record<EffortLevel, AnthropicEffort> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Nearest named effort for an explicit token budget. Anthropic clients may still
 * send `thinking.budget_tokens`, and it cannot be forwarded -- a 400 on every
 * current model -- so it is read as an intensity and re-expressed as the closest
 * level rather than dropped.
 */
function budgetToEffort(budget: number): EffortLevel {
  if (budget <= 2_048) return "minimal";
  if (budget <= 10_000) return "low";
  if (budget <= 24_000) return "medium";
  if (budget <= 48_000) return "high";
  if (budget <= 96_000) return "xhigh";
  return "max";
}

/** Resolve a non-disabled thinking level to a named effort. */
function resolveEffort(thinking: Exclude<ThinkingLevel, "disabled">): EffortLevel {
  if (thinking === "enabled" || thinking === "auto") return "medium";
  if (typeof thinking === "object") return budgetToEffort(thinking.budget);
  return thinking;
}

/** OpenAI Chat Completions / Responses: a named effort plus the client's own
 * output ceiling. `effort` "none" disables reasoning; `maxTokens` undefined means
 * send no ceiling and let the provider's default bound the response. */
export interface ReasoningCeiling {
  effort: string;
  maxTokens?: number;
}

export interface AnthropicThinkingFields {
  /** Whether to think. `budget_tokens` is gone -- see the note on the policy. */
  thinking: { type: "adaptive" } | { type: "disabled" };
  /** How much to think, for `output_config.effort`. Absent when thinking is off. */
  effort?: AnthropicEffort;
  /** The client's own ceiling, bounded by the provider cap. Undefined when the
   * client named none -- this policy does not invent one. */
  max_tokens?: number;
}

/** The shared OpenAI-family rule: Chat Completions and Responses carry the same
 * effort under different key names. */
function reasoningCeiling(
  thinking: ThinkingLevel,
  clientMax: number | undefined,
  providerCap: number | undefined,
): ReasoningCeiling {
  const maxTokens = clientMax != null
    ? Math.max(1, providerCap != null ? Math.min(clientMax, providerCap) : clientMax)
    : undefined;
  if (thinking === "disabled") return { effort: "none", maxTokens };
  return { effort: resolveEffort(thinking), maxTokens };
}

export const ThinkingPolicy = {
  /** OpenAI Chat Completions: `reasoning_effort` + the client's `max_tokens`. */
  openai(thinking: ThinkingLevel, clientMax: number | undefined, providerCap: number | undefined): ReasoningCeiling {
    return reasoningCeiling(thinking, clientMax, providerCap);
  },

  /** OpenAI Responses: `reasoning.effort` + the client's `max_output_tokens`. */
  responses(thinking: ThinkingLevel, clientMax: number | undefined, providerCap: number | undefined): ReasoningCeiling {
    return reasoningCeiling(thinking, clientMax, providerCap);
  },

  /**
   * Anthropic: `thinking` says WHETHER, `output_config.effort` says HOW MUCH.
   *
   * `thinking: {type:"enabled", budget_tokens: N}` is gone -- a 400 on every
   * current model (Fable 5, Opus 5, 4.8, 4.7, Sonnet 5), deprecated on Opus 4.6
   * and Sonnet 4.6 -- replaced by adaptive thinking plus a named effort.
   * `output_config.effort` is GA, needs no beta header, and its scale is the one
   * this proxy already speaks, so a `reasoning_effort` from either OpenAI wire
   * crosses over by NAME.
   *
   * `thinking: {type:"adaptive"}` is emitted alongside the effort because on Opus
   * 4.8, 4.7 and Sonnet 5 an absent `thinking` means no thinking at all -- effort
   * by itself would not switch it on.
   */
  anthropic(
    thinking: ThinkingLevel,
    clientMax: number | undefined,
    providerCap: number | undefined,
  ): AnthropicThinkingFields {
    // Undefined when the client named no ceiling: this wire requires max_tokens,
    // and the upstream saying so is more useful than a number nobody chose.
    const max_tokens = clientMax != null && clientMax > 0
      ? Math.max(1, providerCap != null ? Math.min(clientMax, providerCap) : clientMax)
      : undefined;

    if (thinking === "disabled") return { thinking: { type: "disabled" }, max_tokens };
    return { thinking: { type: "adaptive" }, effort: TO_ANTHROPIC_EFFORT[resolveEffort(thinking)], max_tokens };
  },
};
