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
 * The ladder steps down for ONE reason: a `max_tokens` ceiling too small to hold
 * the reasoning and still answer. That is arithmetic -- a budget bigger than the
 * ceiling returns an empty message.
 *
 * It deliberately does NOT step down to match what an upstream will accept.
 * Providers take different subsets (measured: `reasoning_effort: "max"` is 422 on
 * one Anthropic-compatible gateway and 400 on another), and clamping to the
 * nearest supported tier would quietly answer a question nobody asked. Hydrogen's
 * job is to maximise the caller's freedom, so an upstream that refuses a level
 * refuses it out loud and the error reaches the client. A user who wants
 * degradation configures it: a Model Services fallback step carrying a `thinking`
 * override. This holds even when the level was imposed by an override rather than
 * requested by the client -- that was considered and rejected too.
 */

/**
 * Tokens kept clear of the reasoning so the answer has somewhere to go. Every
 * provider counts reasoning + response against the one output ceiling, so the
 * effective ceiling must leave at least this much beneath the reasoning budget.
 */
const THINKING_RESPONSE_ROOM = 4096;
/**
 * Anthropic's own effort scale. Hydrogen's ladder carries one extra rung at the
 * bottom -- `minimal`, an OpenAI level -- which folds onto `low`.
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
  /** Whether to think. `budget_tokens` is gone -- see the note on the policy. */
  thinking: { type: "adaptive" } | { type: "disabled" };
  /** How much to think, for `output_config.effort`. Absent when thinking is off. */
  effort?: AnthropicEffort;
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
   * Anthropic: `thinking` says WHETHER, `output_config.effort` says HOW MUCH.
   *
   * `thinking: {type:"enabled", budget_tokens: N}` is gone. It is rejected with a
   * 400 on every current model (Fable 5, Opus 5, 4.8, 4.7, Sonnet 5) and
   * deprecated on Opus 4.6 / Sonnet 4.6, replaced by adaptive thinking plus a
   * named effort. `output_config.effort` is GA -- no beta header -- and its
   * scale (low/medium/high/xhigh/max) is the same one this proxy already speaks,
   * so an OpenAI `reasoning_effort` now crosses to Anthropic by NAME instead of
   * being flattened into a token budget it could never be recovered from.
   *
   * Note `thinking: {type:"adaptive"}` is still emitted alongside: on Opus 4.8,
   * 4.7 and Sonnet 5, omitting `thinking` means no thinking at all, so effort
   * alone would not turn it on.
   *
   * max_tokens still has to hold the reasoning and the answer, and the effort
   * budgets remain the estimate that sizes it. Under a hard cap the effort steps
   * DOWN the ladder rather than switching thinking off -- a smaller thought that
   * gets answered beats a bigger one that does not, and silently disabling what
   * the caller asked for is the failure this proxy does not commit.
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

    let { effort, budget } = resolveEffort(thinking);

    // The client asked for this level: send it, whatever their ceiling is. Effort
    // is a soft hint the model paces itself against, not a budget the API sets
    // aside, so there is no arithmetic left that would justify lowering it -- and
    // quietly answering at a level below the one asked for is the substitution
    // this proxy does not make. Same early return the OpenAI policy already does.
    if (!imposed) {
      const ceiling = clientMax != null ? clamp(clientMax) : clamp(budget + THINKING_RESPONSE_ROOM);
      return { thinking: { type: "adaptive" }, effort: TO_ANTHROPIC_EFFORT[effort], max_tokens: Math.max(1, ceiling) };
    }

    // Service-imposed: the client never budgeted for this thought, so their max is
    // the answer's room and the reasoning is added on top. A hard provider cap can
    // cut that sum back, and then the effort steps DOWN the ladder until the
    // reasoning still leaves the answer its room -- never off, which would drop
    // the step's intent entirely.
    const ceiling = clamp(clientMax != null ? clientMax + budget : budget + THINKING_RESPONSE_ROOM);
    const answerRoom = clientMax ?? THINKING_RESPONSE_ROOM;
    let rung = EFFORT_LADDER.indexOf(effort);
    while (budget + answerRoom > ceiling && rung > 0) {
      rung--;
      effort = EFFORT_LADDER[rung];
      budget = EFFORT_BUDGETS[effort];
    }
    return { thinking: { type: "adaptive" }, effort: TO_ANTHROPIC_EFFORT[effort], max_tokens: Math.max(1, ceiling) };
  },
};

/** Anthropic requires max_tokens; use this when neither client nor cap gave one. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
