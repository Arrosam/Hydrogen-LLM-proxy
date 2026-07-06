import { reasoningOf, textOf, type IRRequest, type IRResponse, type IRUsage } from "./ir";

/**
 * Token accounting with a character-based fallback. Some upstreams (notably
 * GLM / Zhipu Anthropic-compatible endpoints) report the real prompt count
 * only in the final streaming usage frame; a degraded or very long stream can
 * commit 2xx headers and produce output but never deliver that frame, leaving
 * usage at zero. Rather than log/charge 0 tokens for a request that clearly
 * did work, we estimate from character counts and flag the result.
 */

/** Rough average characters per token (English-ish). */
const CHARS_PER_TOKEN = 4;

function approxTokens(chars: number): number {
  return chars > 0 ? Math.max(1, Math.round(chars / CHARS_PER_TOKEN)) : 0;
}

/** Approximate the character size of an IR request's prompt (text-ish parts). */
function promptChars(ir: IRRequest): number {
  let n = ir.system ? ir.system.length : 0;
  for (const m of ir.messages) {
    for (const p of m.content) {
      switch (p.type) {
        case "text":
        case "reasoning":
          n += p.text.length;
          break;
        case "tool_use":
          n += p.name.length + JSON.stringify(p.input ?? {}).length;
          break;
        case "tool_result":
          for (const cp of p.content) if (cp.type === "text") n += cp.text.length;
          break;
        case "image":
          n += 800; // rough flat cost so image prompts aren't estimated as ~0
          break;
      }
    }
  }
  return n;
}

export function estimatePromptTokens(ir: IRRequest): number {
  return approxTokens(promptChars(ir));
}

export function estimateCompletionTokens(text: string): number {
  return approxTokens(text.length);
}

/**
 * If `reported` already has a non-zero total, return it unchanged. Otherwise,
 * when `outputText` shows the call produced something, return a character-based
 * estimate (flagged `estimated`). Prompt tokens come from the request, so a
 * large context isn't undercounted to a few hundred completion tokens.
 */
export function usageWithFallback(
  reported: IRUsage,
  ir: IRRequest,
  outputText: string,
): { usage: IRUsage; estimated: boolean } {
  if (reported.totalTokens > 0) return { usage: reported, estimated: false };
  if (!outputText) return { usage: reported, estimated: false };
  const promptTokens = estimatePromptTokens(ir);
  const completionTokens = estimateCompletionTokens(outputText);
  const totalTokens = promptTokens + completionTokens;
  if (totalTokens === 0) return { usage: reported, estimated: false };
  return { usage: { promptTokens, completionTokens, totalTokens }, estimated: true };
}

/** Apply the usage fallback to a buffered response's own IR usage. */
export function withUsageFallback(ir: IRRequest, respIR: IRResponse): IRResponse {
  const text = textOf(respIR.content) + reasoningOf(respIR.content);
  const { usage } = usageWithFallback(respIR.usage, ir, text);
  return usage === respIR.usage ? respIR : { ...respIR, usage };
}
