import { isEffortLevel, type EffortLevel, type ThinkingLevel } from "./params";

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

/** Largest manual budget that still maps to each named effort; anything above the last is "max". */
const EFFORT_BUDGET_CEILING = {
  MINIMAL: 2_048,
  LOW: 10_000,
  MEDIUM: 24_000,
  HIGH: 48_000,
  XHIGH: 96_000,
} as const;

/** Effort an `enabled` / `auto` thinking level resolves to. */
const DEFAULT_EFFORT: EffortLevel = "medium";

/** The OpenAI-family effort spelling that turns reasoning off. */
export const EFFORT_OFF = "none";
/** A second spelling clients send for the same thing. */
export const EFFORT_DISABLED = "disabled";

/** Floor of a bounded output ceiling. */
const MIN_OUTPUT_TOKENS = 1;

/** Claude models before 4.6 have no adaptive thinking and take a manual budget. */
const CLAUDE_VERSION_RE = /claude-(?:sonnet|opus|haiku)-(\d+)(?:[.-](\d)(?=-|$))?/i;
const CLAUDE_3_RE = /claude-3[.-]/i;
const ADAPTIVE_THINKING_SINCE = { major: 4, minor: 6 } as const;

/** Manual thinking budget per named effort, for those pre-adaptive models. */
const LEGACY_EFFORT_BUDGETS: Readonly<Record<EffortLevel, number>> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 65536 };

/** Nearest named effort when translating a manual budget to an OpenAI wire. */
function budgetToEffort(budget: number): EffortLevel {
  if (budget <= EFFORT_BUDGET_CEILING.MINIMAL) return "minimal";
  if (budget <= EFFORT_BUDGET_CEILING.LOW) return "low";
  if (budget <= EFFORT_BUDGET_CEILING.MEDIUM) return "medium";
  if (budget <= EFFORT_BUDGET_CEILING.HIGH) return "high";
  if (budget <= EFFORT_BUDGET_CEILING.XHIGH) return "xhigh";
  return "max";
}

/** Resolve a non-disabled thinking level to a named effort. */
function resolveEffort(thinking: Exclude<ThinkingLevel, "disabled">): EffortLevel {
  if (thinking === "enabled" || thinking === "auto") return DEFAULT_EFFORT;
  if (typeof thinking === "object") return budgetToEffort(thinking.budget);
  return thinking;
}

/**
 * An OpenAI-family effort value (`reasoning_effort` / `reasoning.effort`) as a
 * thinking level: either spelling of "off", a named effort, or nothing this
 * proxy models.
 */
export function effortToThinking(effort: unknown): ThinkingLevel | undefined {
  if (effort === EFFORT_OFF || effort === EFFORT_DISABLED) return "disabled";
  return isEffortLevel(effort) ? effort : undefined;
}

/** OpenAI Chat Completions / Responses: a named effort plus the client's own
 * output ceiling. `effort` "none" disables reasoning and is absent when the
 * request set no thinking level; `maxTokens` undefined means send no ceiling
 * and let the provider's default bound the response. */
export interface ReasoningCeiling {
  effort?: string;
  maxTokens?: number;
}

/**
 * Fit the client's output-token max under the provider's hard cap. Asking for
 * more than a provider allows gets the whole request rejected, so the cap wins.
 * A request that named no max keeps naming none -- the provider's own default
 * is already within its limit.
 *
 * The three callers disagree on the edges and each keeps its own rule:
 * `floor` lifts a bounded value that fell below it, and `positiveOnly` treats
 * a non-positive client max as no max at all.
 */
export function boundMaxTokens(
  clientMax: number | undefined,
  providerCap: number | undefined,
  opts: { floor?: number; positiveOnly?: boolean } = {},
): number | undefined {
  if (clientMax == null || (opts.positiveOnly && !(clientMax > 0))) return undefined;
  const bounded = providerCap != null ? Math.min(clientMax, providerCap) : clientMax;
  return opts.floor != null ? Math.max(opts.floor, bounded) : bounded;
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

export const ThinkingPolicy = {
  /**
   * The shared OpenAI-family rule: Chat Completions (`reasoning_effort` +
   * `max_tokens`) and Responses (`reasoning.effort` + `max_output_tokens`)
   * carry the same effort and ceiling under different key names.
   *
   * With a thinking level set the policy owns the ceiling -- reasoning is
   * spent out of it, so it is floored. With none set there is no effort to
   * send and the client's max is only capped.
   */
  openai(thinking: ThinkingLevel | undefined, clientMax: number | undefined, providerCap: number | undefined): ReasoningCeiling {
    if (!thinking) return { maxTokens: boundMaxTokens(clientMax, providerCap) };
    const maxTokens = boundMaxTokens(clientMax, providerCap, { floor: MIN_OUTPUT_TOKENS });
    return { effort: thinking === "disabled" ? EFFORT_OFF : resolveEffort(thinking), maxTokens };
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
    const max_tokens = boundMaxTokens(clientMax, providerCap, { floor: MIN_OUTPUT_TOKENS, positiveOnly: true });

    if (thinking === "disabled") return { thinking: { type: "disabled" }, max_tokens };
    // Explicit manual budgets remain valid on older models. For cross-family
    // named efforts targeting pre-adaptive Claude models, use a manual budget.
    // Never grow the caller's output ceiling to accommodate it.
    const version = CLAUDE_VERSION_RE.exec(model ?? "");
    const legacy = CLAUDE_3_RE.test(model ?? "") ||
      (version != null && Number(version[1]) === ADAPTIVE_THINKING_SINCE.major && Number(version[2] ?? 0) < ADAPTIVE_THINKING_SINCE.minor);
    if (typeof thinking === "object" || legacy) {
      const budget = typeof thinking === "object" ? thinking.budget : LEGACY_EFFORT_BUDGETS[resolveEffort(thinking)];
      return { thinking: { type: "enabled", budget_tokens: budget }, max_tokens };
    }
    return { thinking: { type: "adaptive" }, effort: TO_ANTHROPIC_EFFORT[resolveEffort(thinking)], max_tokens };
  },
};
