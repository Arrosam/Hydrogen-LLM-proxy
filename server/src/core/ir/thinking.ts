import type { EffortLevel, ThinkingLevel } from "./params";

/**
 * Maps the canonical extended-thinking level onto each wire family's own knobs.
 *
 * Every provider bills reasoning tokens *inside* the single output ceiling
 * (Anthropic's `max_tokens`, OpenAI's `max_output_tokens` / `max_tokens`), so
 * the ceiling has to hold the reasoning AND the answer. Get it wrong and the
 * model spends the whole ceiling thinking and returns an empty message, billed
 * in full and reported as a success. This policy is the one place that math
 * lives.
 *
 * The crucial input is `imposed`: did the *service* turn thinking on (a step or
 * stage override the client never asked for), or did the *client* request it?
 *  - Imposed: the client's max means "this much answer"; the reasoning budget is
 *    added on top of it, because the client never budgeted for thinking it did
 *    not ask for.
 *  - Client-requested: the client's max already accounts for its own reasoning
 *    (it is speaking a thinking-aware API), so the max is taken as-is.
 * Under a hard provider cap the reasoning is trimmed -- lower effort, or off
 * entirely -- until the answer still has room, because a smaller thought that
 * gets answered beats a bigger one that does not.
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

/** The efforts cheapest-first -- the order effort steps down under a tight cap.
 * Derived from EFFORT_BUDGETS so the two can never disagree (string keys keep
 * insertion order). */
const EFFORT_LADDER = Object.keys(EFFORT_BUDGETS) as EffortLevel[];

/**
 * Tokens kept clear of the reasoning so the answer has somewhere to go. Every
 * provider counts reasoning + response against the one output ceiling, so the
 * effective ceiling must leave at least this much beneath the reasoning budget.
 */
const THINKING_RESPONSE_ROOM = 4096;
/** Anthropic's minimum accepted thinking budget. */
const MIN_THINKING_BUDGET = 1024;

/**
 * Nearest named effort for an explicit token budget, so a small budget isn't
 * sent as "high". Exact token budgets can only be conveyed to an Anthropic
 * provider (budget_tokens); for OpenAI this picks the closest bucket.
 */
function budgetToEffort(budget: number): EffortLevel {
  if (budget <= EFFORT_BUDGETS.minimal) return "minimal";
  if (budget <= 10_000) return "low";
  if (budget <= 24_000) return "medium";
  if (budget <= 48_000) return "high";
  if (budget <= 96_000) return "xhigh";
  return "max";
}

/** Resolve a non-disabled thinking level to a named effort and a token budget. */
function resolveEffort(thinking: Exclude<ThinkingLevel, "disabled">): { effort: EffortLevel; budget: number } {
  if (thinking === "enabled" || thinking === "auto") return { effort: "medium", budget: EFFORT_BUDGETS.medium };
  if (typeof thinking === "object") return { effort: budgetToEffort(thinking.budget), budget: thinking.budget };
  return { effort: thinking, budget: EFFORT_BUDGETS[thinking] };
}

/** OpenAI Chat Completions / Responses: a named effort plus the single output
 * ceiling that has to hold it. `effort` "none" disables reasoning; `maxTokens`
 * undefined means send no ceiling and let the provider's default bound it. */
export interface ReasoningCeiling {
  effort: string;
  maxTokens?: number;
}

export interface AnthropicThinkingFields {
  thinking: { type: "enabled"; budget_tokens: number } | { type: "disabled" };
  max_tokens: number;
}

/**
 * The shared OpenAI-family rule (Chat Completions and Responses map reasoning
 * the same way: a named effort and one output ceiling that includes reasoning).
 */
function reasoningCeiling(
  thinking: ThinkingLevel,
  clientMax: number | undefined,
  providerCap: number | undefined,
  imposed: boolean,
): ReasoningCeiling {
  const clamp = (n: number): number => (providerCap != null ? Math.min(n, providerCap) : n);

  // Reasoning off: the client's max is the whole answer budget.
  if (thinking === "disabled") {
    return { effort: "none", maxTokens: clientMax != null ? Math.max(1, clamp(clientMax)) : undefined };
  }

  let { effort, budget } = resolveEffort(thinking);

  // No client ceiling to squeeze the answer: send the effort, let the provider's
  // own default bound the response.
  if (clientMax == null) return { effort, maxTokens: undefined };

  // The client asked for its own thinking, so its max already accounts for the
  // reasoning; take it as-is.
  if (!imposed) return { effort, maxTokens: Math.max(1, clamp(clientMax)) };

  // Service-imposed: give the reasoning its budget on top of the client's answer.
  if (providerCap == null) return { effort, maxTokens: clientMax + budget };

  // Under a hard cap, step the effort down until its budget plus the answer's
  // room fits. Unlike Anthropic, OpenAI's effort is a soft hint with no token
  // budget, so a light effort self-limits inside a small ceiling -- stepping to
  // minimal is enough to keep the answer room; no need to disable reasoning.
  let rung = EFFORT_LADDER.indexOf(effort);
  while (budget + THINKING_RESPONSE_ROOM > providerCap && rung > 0) {
    rung--;
    effort = EFFORT_LADDER[rung];
    budget = EFFORT_BUDGETS[effort];
  }
  return { effort, maxTokens: Math.min(clientMax + budget, providerCap) };
}

export const ThinkingPolicy = {
  /** OpenAI Chat Completions reasoning_effort + the max_tokens that holds it. */
  openai(thinking: ThinkingLevel, clientMax: number | undefined, providerCap: number | undefined, imposed: boolean): ReasoningCeiling {
    return reasoningCeiling(thinking, clientMax, providerCap, imposed);
  },

  /** OpenAI Responses reasoning.effort + the max_output_tokens that holds it. */
  responses(thinking: ThinkingLevel, clientMax: number | undefined, providerCap: number | undefined, imposed: boolean): ReasoningCeiling {
    return reasoningCeiling(thinking, clientMax, providerCap, imposed);
  },

  /**
   * Anthropic thinking.budget_tokens + the max_tokens that bounds it. Anthropic
   * has an explicit budget field, so the budget is fit *under* the ceiling
   * rather than laddered by effort -- but the same `imposed` rule and the same
   * "drop thinking rather than starve the answer" floor apply.
   */
  anthropic(
    thinking: ThinkingLevel,
    clientMax: number | undefined,
    providerCap: number | undefined,
    imposed: boolean,
  ): AnthropicThinkingFields {
    const clamp = (n: number): number => (providerCap != null ? Math.min(n, providerCap) : n);

    if (thinking === "disabled") {
      // A max_tokens of 0 (or none) is not a valid Anthropic request; fall back.
      const base = clientMax != null && clientMax > 0 ? clientMax : providerCap ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
      return { thinking: { type: "disabled" }, max_tokens: Math.max(1, clamp(base)) };
    }

    let { budget } = resolveEffort(thinking);
    budget = Math.max(MIN_THINKING_BUDGET, budget);

    // The output ceiling that must hold the budget plus the answer.
    let ceiling: number;
    if (clientMax != null) {
      ceiling = imposed ? clientMax + budget : clientMax;
    } else {
      ceiling = budget + THINKING_RESPONSE_ROOM;
    }
    ceiling = clamp(ceiling);

    // Anthropic requires max_tokens > budget_tokens >= MIN_THINKING_BUDGET, so a
    // ceiling that cannot even hold the minimum budget plus one answer token
    // cannot carry thinking at all. Drop it so the answer gets the whole ceiling,
    // rather than emit max_tokens = budget+1 (one-token answer, and above the
    // cap when the ceiling was the cap).
    if (ceiling <= MIN_THINKING_BUDGET) {
      return { thinking: { type: "disabled" }, max_tokens: Math.max(1, ceiling) };
    }

    // Fit the budget under the ceiling, leaving the answer its room; floor at the
    // minimum, which still fits because ceiling > MIN_THINKING_BUDGET.
    if (budget + THINKING_RESPONSE_ROOM > ceiling) {
      budget = Math.max(MIN_THINKING_BUDGET, ceiling - THINKING_RESPONSE_ROOM);
    }
    return { thinking: { type: "enabled", budget_tokens: budget }, max_tokens: ceiling };
  },
};

/** Anthropic requires max_tokens; use this when neither client nor cap gave one. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
