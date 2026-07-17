import type { EffortLevel, ThinkingLevel } from "./params";

/**
 * Maps the canonical extended-thinking level onto each wire family's own knobs.
 *
 * The three families express reasoning differently: OpenAI Chat Completions and
 * the Responses API take a named `reasoning_effort`; Anthropic takes an explicit
 * `thinking.budget_tokens` bounded by `max_tokens`. This policy is the single
 * place those mappings live -- including the rule that on Anthropic the thinking
 * budget must fit *under* the effective max_tokens ceiling (the client's
 * requested max and/or the provider's hard output cap), because inflating
 * max_tokens past a provider's limit gets the whole request rejected and the
 * client then gets no thinking at all.
 */

/** Token budgets for the named effort levels (Anthropic has no effort field). */
const EFFORT_BUDGETS: Record<EffortLevel, number> = {
  minimal: 2048,
  low: 4096,
  medium: 16000,
  high: 32000,
  xhigh: 64000,
  max: 128000,
};

/**
 * Tokens reserved under max_tokens for the response text. Anthropic counts
 * thinking + response against the single max_tokens budget, so the effective
 * thinking budget must leave room beneath max_tokens for the actual answer.
 */
const THINKING_RESPONSE_ROOM = 4096;
/** Anthropic's minimum accepted thinking budget. */
const MIN_THINKING_BUDGET = 1024;

/**
 * OpenAI Chat Completions has no thinking-budget field -- only reasoning_effort
 * (low/medium/high/...). Map an explicit token budget to the nearest named
 * effort level so a small budget isn't sent as "high". Exact token budgets can
 * only be conveyed to an Anthropic-format provider (thinking.budget_tokens).
 */
function budgetToEffort(budget: number): EffortLevel {
  if (budget <= 4096) return "low";
  if (budget <= 10_000) return "low";
  if (budget <= 24_000) return "medium";
  if (budget <= 48_000) return "high";
  if (budget <= 96_000) return "xhigh";
  return "max";
}

export interface OpenAIThinkingFields {
  reasoning_effort: string;
  /** Set only when the level is a budget and no max was otherwise given. */
  max_tokens?: number;
}

export interface AnthropicThinkingFields {
  thinking: { type: "enabled"; budget_tokens: number } | { type: "disabled" };
  max_tokens: number;
}

export interface ResponsesThinkingFields {
  reasoning: { effort: string };
  /** The ceiling that has to hold the reasoning AND the answer. undefined = send
   * none and let the provider's own default bound the response. */
  max_output_tokens?: number;
}

/** Named efforts, cheapest first — the order the effort steps down in when a
 * provider's cap cannot hold the reasoning and the answer both. */
const EFFORT_LADDER: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export const ThinkingPolicy = {
  /** OpenAI Chat Completions reasoning_effort (+ max_tokens when a budget was given). */
  openai(thinking: ThinkingLevel, currentMax: number | undefined): OpenAIThinkingFields {
    if (thinking === "disabled") return { reasoning_effort: "none" };
    if (thinking === "enabled" || thinking === "auto") return { reasoning_effort: "medium" };
    if (typeof thinking === "object") {
      const out: OpenAIThinkingFields = { reasoning_effort: budgetToEffort(thinking.budget) };
      if (currentMax == null) out.max_tokens = thinking.budget;
      return out;
    }
    // A named effort level passes through verbatim.
    return { reasoning_effort: thinking };
  },

  /**
   * OpenAI Responses reasoning.effort, and the max_output_tokens that has to
   * hold it.
   *
   * The Responses API counts reasoning tokens *inside* max_output_tokens, the
   * same way Anthropic counts thinking inside max_tokens. So a client's max
   * passed through verbatim is a budget the reasoning may spend in full: the
   * model thinks, hits the ceiling, and returns `status: "incomplete"` with no
   * message at all -- an empty answer, billed in full, reported as a success.
   *
   * The client's max means "this much *answer*". Thinking is the service's
   * decision, not the client's, so it gets room on top rather than out of the
   * client's budget -- bounded by the provider's hard cap. If even the cap
   * cannot hold both, the effort steps down until the answer still has room,
   * because a smaller thought that gets answered beats a bigger one that
   * doesn't.
   */
  responses(
    thinking: ThinkingLevel,
    clientMax: number | undefined,
    providerCap: number | undefined,
  ): ResponsesThinkingFields {
    const capped = (n: number | undefined): number | undefined =>
      n == null ? undefined : providerCap != null ? Math.min(n, providerCap) : n;

    // No reasoning to make room for: the client's max is the whole budget.
    if (thinking === "disabled") {
      return { reasoning: { effort: "none" }, max_output_tokens: capped(clientMax) };
    }

    let effort: EffortLevel;
    let budget: number;
    if (thinking === "enabled" || thinking === "auto") {
      effort = "medium";
      budget = EFFORT_BUDGETS.medium;
    } else if (typeof thinking === "object") {
      effort = budgetToEffort(thinking.budget);
      budget = thinking.budget;
    } else {
      effort = thinking;
      budget = EFFORT_BUDGETS[thinking];
    }

    // The client named no max, so nothing is squeezing the answer: let the
    // provider's own default bound the response rather than inventing a ceiling.
    if (clientMax == null) return { reasoning: { effort } };

    if (providerCap == null) {
      return { reasoning: { effort }, max_output_tokens: clientMax + budget };
    }

    // Under a hard cap, buy the answer its room by thinking less.
    let rung = EFFORT_LADDER.indexOf(effort);
    while (clientMax + budget > providerCap && rung > 0) {
      rung--;
      effort = EFFORT_LADDER[rung];
      budget = EFFORT_BUDGETS[effort];
    }
    return { reasoning: { effort }, max_output_tokens: Math.min(clientMax + budget, providerCap) };
  },

  /**
   * Anthropic thinking.budget_tokens + the max_tokens that bounds it. `clientMax`
   * is the client's requested max_tokens (undefined = none); `providerCap` is the
   * provider's hard output-token ceiling (undefined = none). The budget is fit
   * under whichever of those is smaller, shrinking the budget rather than
   * inflating max_tokens past a limit the provider would reject.
   */
  anthropic(
    thinking: ThinkingLevel,
    clientMax: number | undefined,
    providerCap: number | undefined,
  ): AnthropicThinkingFields {
    if (thinking === "disabled") {
      // Keep a valid max_tokens even when thinking is off.
      const cap = clientMax ?? providerCap ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
      return { thinking: { type: "disabled" }, max_tokens: Math.min(cap, providerCap ?? cap) };
    }

    let budget: number;
    if (thinking === "enabled" || thinking === "auto") {
      budget = clientMax != null ? Math.min(clientMax, 16000) : 16000;
    } else if (typeof thinking === "object") {
      budget = thinking.budget;
    } else {
      budget = EFFORT_BUDGETS[thinking];
    }
    budget = Math.max(MIN_THINKING_BUDGET, budget);

    // The effective ceiling max_tokens may take: the client's request and the
    // provider's hard cap, whichever is tighter. When the client set no max, size
    // max_tokens to give the budget room -- but still never above the provider cap.
    const desired = clientMax != null ? clientMax : budget + THINKING_RESPONSE_ROOM;
    const ceiling = providerCap != null ? Math.min(desired, providerCap) : desired;

    let maxTokens: number;
    if (ceiling < budget + THINKING_RESPONSE_ROOM) {
      budget = Math.max(MIN_THINKING_BUDGET, ceiling - THINKING_RESPONSE_ROOM);
      // Guarantee Anthropic's hard rule (max_tokens > budget_tokens) even for a
      // ceiling too small to hold the minimum budget plus response room.
      maxTokens = ceiling <= budget ? budget + 1 : ceiling;
    } else {
      maxTokens = ceiling;
    }
    return { thinking: { type: "enabled", budget_tokens: budget }, max_tokens: maxTokens };
  },
};

/** Anthropic requires max_tokens; use this when neither client nor cap gave one. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
