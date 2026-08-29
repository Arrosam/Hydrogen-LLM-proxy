/** Token usage, normalized across every provider's own accounting shape. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's cache (OpenAI cached_tokens /
   * Anthropic cache_read_input_tokens). */
  cachedInputTokens?: number;
  /** Anthropic cache_creation_input_tokens. */
  cacheCreationInputTokens?: number;
  /** Reasoning/thinking tokens inside the completion (OpenAI reasoning_tokens). */
  reasoningTokens?: number;
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

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
