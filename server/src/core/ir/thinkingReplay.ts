import type { Family } from "../format/family";
import type { ContentPart, ReasoningPart } from "./content";
import type { StreamEvent } from "./stream";
import type { ThinkingFormat } from "./thinkingFormat";

/** Safe, content-free configuration error. Never substitute `original`: a
 * service that hides thinking must not expose it just to make replay work. */
export const THINKING_REPLAY_ERROR = "Stateless continuation with replay-required reasoning requires original/native reasoning format or stateful continuation; configure thinkingFormat as original, reasoning, or reasoning_content, or use a stateful Responses conversation/previous_response_id.";

export class ThinkingReplayError extends Error {
  readonly statusCode = 400;
  constructor() {
    super(THINKING_REPLAY_ERROR);
    this.name = "ThinkingReplayError";
  }
}

function isLossy(format: ThinkingFormat): boolean {
  return format === "none" || format === "think_tags";
}

type ReplayMetadata = Pick<ReasoningPart, "origin" | "signature" | "redacted"> & { itemId?: string };

/** Anthropic-compatible providers can require even unsigned thinking on later
 * ordinary turns (not only tool continuations). Responses ids/encrypted data
 * likewise belong to the replay item, not its display text. Family is a fallback
 * for canonical deltas/older executors without per-block provenance; explicit
 * Chat provenance keeps ordinary textual Chat thinking eligible for shaping. */
function requiresReplay(part: ReplayMetadata, upstreamFamily: Family): boolean {
  const origin = part.origin ?? upstreamFamily;
  return origin === "anthropic" || origin === "openai_responses" ||
    part.signature !== undefined || part.redacted === true || part.itemId !== undefined;
}

/** Check the canonical response BEFORE presentation removes its metadata. This
 * policy belongs to stateless delivery, never to the presentation transformer:
 * hosted/stateful callers retain the original response for their next request. */
export function thinkingReplayError(
  content: readonly ContentPart[],
  format: ThinkingFormat,
  upstreamFamily: Family,
): string | undefined {
  return isLossy(format) && content.some(part => part.type === "reasoning" && requiresReplay(part, upstreamFamily))
    ? THINKING_REPLAY_ERROR : undefined;
}

/** Fail as soon as a replay-bearing block appears, before dropping it, inlining
 * its text, or delivering the following tool call. No stream buffering: origin
 * and family identify native blocks before their trailing signatures arrive.
 * Throwing also closes the upstream iterator, rather than draining a potentially
 * unbounded response after the client can no longer use it. */
export async function* requireThinkingReplay(
  events: AsyncGenerator<StreamEvent>,
  format: ThinkingFormat,
  upstreamFamily: Family,
): AsyncGenerator<StreamEvent> {
  if (!isLossy(format)) { yield* events; return; }
  // A delta has no provenance of its own; retain a boundary's explicit origin.
  let origin: ReasoningPart["origin"];
  for await (const event of events) {
    if (event.type === "reasoning_start" || event.type === "reasoning_stop") {
      const metadata = { ...event, origin: event.origin ?? origin, itemId: event.id };
      if (requiresReplay(metadata, upstreamFamily)) throw new ThinkingReplayError();
      origin = event.type === "reasoning_start" ? event.origin : undefined;
    } else if (event.type === "reasoning_delta" && requiresReplay({ origin }, upstreamFamily)) {
      throw new ThinkingReplayError();
    }
    yield event;
  }
}
