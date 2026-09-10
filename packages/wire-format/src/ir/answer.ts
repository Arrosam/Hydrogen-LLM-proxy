import type { ContentPart, StopReason } from "./content.js";
import type { StreamEvent } from "./stream.js";

function missingAnswer(hasAnswer: boolean, hasThinking: boolean, stop: StopReason): string | undefined {
  if (hasAnswer || stop === "content_filter") return undefined;
  if (stop === "length") return "upstream exhausted the output token limit before producing an answer or tool call";
  return hasThinking
    ? "upstream returned thinking but no answer or tool call"
    : "upstream returned no answer or tool call";
}

/** A tool-only response is actionable. Thinking alone is not a final answer. */
export function missingAnswerReason(content: ContentPart[], stop: StopReason): string | undefined {
  return missingAnswer(
    content.some(p => p.type === "tool_use" || (p.type === "text" && p.text.trim().length > 0)),
    content.some(p => p.type === "reasoning"), stop,
  );
}

/** Validate after client shaping, preserving every upstream usage counter. */
export async function* requireAnswer(events: AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
  let hasAnswer = false;
  let hasThinking = false;
  for await (const ev of events) {
    if (ev.type === "tool_start" || (ev.type === "text_delta" && ev.text.trim())) hasAnswer = true;
    if (ev.type === "reasoning_start" || ev.type === "reasoning_delta" || ev.type === "reasoning_stop") hasThinking = true;
    if (ev.type === "finish" && !ev.incomplete && !ev.error) {
      const error = missingAnswer(hasAnswer, hasThinking, ev.stopReason);
      yield error ? { ...ev, error } : ev;
    } else yield ev;
  }
}
