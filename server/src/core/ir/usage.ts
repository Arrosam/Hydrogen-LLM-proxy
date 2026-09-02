/**
 * Token usage, normalized across every provider's own accounting shape.
 *
 * ONE CONVENTION, and it is the inclusive one: `promptTokens` is every input
 * token the model read on this request -- cache hits and cache writes included.
 * `cachedInputTokens` and `cacheCreationInputTokens` are SUBSETS of it, never
 * additions to it.
 *
 * The wires disagree about this, which is the whole reason the rule has to be
 * written down. OpenAI's `prompt_tokens` is already the total and
 * `prompt_tokens_details.cached_tokens` is a slice of it. Anthropic's
 * `input_tokens` is the opposite: the uncached REMAINDER, with
 * `cache_read_input_tokens` and `cache_creation_input_tokens` sitting outside
 * it, so the prompt the model actually read is the sum of all three.
 *
 * Carrying `input_tokens` straight into `promptTokens` is therefore not a
 * relabeling, it is a subtraction. An OpenAI-speaking client behind an
 * Anthropic upstream was shown the uncached remainder as its whole prompt
 * count: a 120k-token conversation with a warm cache reported a few hundred
 * tokens, so anything reading that number to draw a context-window gauge drew
 * it near-empty. The fold happens at the Anthropic parse boundary and the split
 * is restored at the Anthropic render boundary, so both wires say what their
 * own clients expect and the number in between means one thing.
 */
export interface Usage {
  /** EVERY input token read, cache hits and cache writes included. */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's cache (OpenAI cached_tokens /
   * Anthropic cache_read_input_tokens). A subset of {@link promptTokens}. */
  cachedInputTokens?: number;
  /** Prompt tokens written INTO the cache (Anthropic
   * cache_creation_input_tokens). Also a subset of {@link promptTokens}. */
  cacheCreationInputTokens?: number;
  /** Reasoning/thinking tokens inside the completion (OpenAI reasoning_tokens). */
  reasoningTokens?: number;
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * The prompt tokens that were neither read from nor written to the cache --
 * Anthropic's `input_tokens`. Floored at zero: an upstream whose counters do
 * not add up must not produce a negative token count on the client's wire.
 */
export function uncachedPromptTokens(u: Usage): number {
  return Math.max(0, u.promptTokens - (u.cachedInputTokens ?? 0) - (u.cacheCreationInputTokens ?? 0));
}

/**
 * Fold an Anthropic-shaped split back into the canonical inclusive total.
 * `uncached` is that wire's `input_tokens`.
 */
export function foldCacheIntoPrompt(uncached: number, cachedRead?: number, cacheWrite?: number): number {
  return uncached + (cachedRead ?? 0) + (cacheWrite ?? 0);
}

/**
 * Sum two usages, detail counters included.
 *
 * The detail fields used to be dropped here, so a Micro Agent -- which adds up
 * one usage per stage -- reported a total with no cached, cache-creation or
 * reasoning tokens at all, however many its stages actually used. They are
 * summed like the rest; a field stays absent only when NEITHER side had it, so
 * "this provider never reported a cache" and "the cache served zero tokens"
 * remain distinguishable downstream.
 */
export function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x?: number, y?: number): number | undefined =>
    x == null && y == null ? undefined : (x ?? 0) + (y ?? 0);
  const cachedInputTokens = sum(a.cachedInputTokens, b.cachedInputTokens);
  const cacheCreationInputTokens = sum(a.cacheCreationInputTokens, b.cacheCreationInputTokens);
  const reasoningTokens = sum(a.reasoningTokens, b.reasoningTokens);
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens != null ? { cacheCreationInputTokens } : {}),
    ...(reasoningTokens != null ? { reasoningTokens } : {}),
  };
}
