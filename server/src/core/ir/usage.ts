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

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
