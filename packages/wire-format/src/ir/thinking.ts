import type { EffortLevel, ThinkingLevel } from "./params.js";

/** Maps thinking controls without changing the caller's output ceiling.
 * Native Anthropic options are preserved by its request adapter. */

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

/** Nearest named effort when translating a manual budget to an OpenAI wire. */
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
  /** Whether to think, with a budget for manual mode. */
  thinking: { type: "adaptive" } | { type: "disabled" } | { type: "enabled"; budget_tokens: number };
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

  /** Anthropic manual budgets and adaptive named efforts. */
  anthropic(
    thinking: ThinkingLevel,
    clientMax: number | undefined,
    providerCap: number | undefined,
    model?: string,
  ): AnthropicThinkingFields {
    // Undefined when the client named no ceiling: this wire requires max_tokens,
    // and the upstream saying so is more useful than a number nobody chose.
    const max_tokens = clientMax != null && clientMax > 0
      ? Math.max(1, providerCap != null ? Math.min(clientMax, providerCap) : clientMax)
      : undefined;

    if (thinking === "disabled") return { thinking: { type: "disabled" }, max_tokens };
    // Explicit manual budgets remain valid on older models. For cross-family
    // named efforts targeting pre-adaptive Claude models, use a manual budget.
    // Never grow the caller's output ceiling to accommodate it.
    const version = /claude-(?:sonnet|opus|haiku)-(\d+)(?:[.-](\d)(?=-|$))?/i.exec(model ?? "");
    const legacy = /claude-3[.-]/i.test(model ?? "") ||
      (version != null && Number(version[1]) === 4 && Number(version[2] ?? 0) < 6);
    if (typeof thinking === "object" || legacy) {
      const budgets: Record<EffortLevel, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 65536 };
      const budget = typeof thinking === "object" ? thinking.budget : budgets[resolveEffort(thinking)];
      return { thinking: { type: "enabled", budget_tokens: budget }, max_tokens };
    }
    return { thinking: { type: "adaptive" }, effort: TO_ANTHROPIC_EFFORT[resolveEffort(thinking)], max_tokens };
  },
};
