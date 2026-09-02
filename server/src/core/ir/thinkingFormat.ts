import type { ContentPart, ReasoningPart, TextPart } from "./content";
import { withoutReasoning, type StreamEvent } from "./stream";

/**
 * How a service presents the model's thinking to ITS client.
 *
 * This is a response-shaping setting, not a request one: `thinking` decides
 * whether the upstream thinks and how hard, and this decides what the answer
 * looks like once it has. The two are independent — a service can leave
 * thinking entirely to the client and still normalize how it comes back.
 *
 * Providers do not agree on any of it. DeepSeek's compatible endpoint returns
 * `reasoning_content`, OpenRouter-style gateways return `reasoning`, Anthropic
 * and Responses have their own block types, and a large family of open-weight
 * models served through vLLM / Ollama / llama.cpp return nothing structured at
 * all — the thinking is simply `<think>…</think>` at the head of the answer
 * text. A client wired for one of those spellings sees nothing from the others,
 * and in the `<think>` case sees the model's private reasoning presented as its
 * answer.
 *
 * `original` is the default and means EXACTLY nothing happens: no scanning, no
 * rewriting, byte-for-byte what the pipeline produced before this existed. That
 * matters more than it looks — the `<think>` scan is deliberately not on by
 * default, because a client that already parses those tags itself would have
 * them silently taken away.
 *
 * Every other value implies "find the thinking wherever it is, then say it this
 * way", because a format conversion cannot work without the finding half.
 *
 * - `reasoning_content` — Chat Completions clients get `reasoning_content` only
 * - `reasoning`         — Chat Completions clients get `reasoning` only
 * - `think_tags`        — inlined as `<think>…</think>` ahead of the answer
 * - `none`              — kept from the client entirely (the upstream still thinks)
 *
 * The two field names are a Chat Completions distinction and nothing else:
 * Anthropic and Responses each have exactly one native shape, so both values
 * leave those wires on their own block type rather than inventing a field their
 * clients would not read. `think_tags` and `none` are content-level and apply
 * to all three.
 */
export type ThinkingFormat = "original" | "reasoning_content" | "reasoning" | "think_tags" | "none";

export const THINKING_FORMATS: readonly ThinkingFormat[] = [
  "original",
  "reasoning_content",
  "reasoning",
  "think_tags",
  "none",
];

/** Whether a format asks for anything at all. `original` and absence do not. */
export function isThinkingFormatActive(f: ThinkingFormat | undefined): f is Exclude<ThinkingFormat, "original"> {
  return f != null && f !== "original";
}

/**
 * Tag names seen in the wild for the same thing. `think` is the DeepSeek-R1
 * convention every distill and most open-weight reasoners copied; `thinking`
 * and `reasoning` show up in prompt-templated variants.
 */
const TAG_NAMES = ["think", "thinking", "reasoning"] as const;
const OPEN_RE = new RegExp(`^\\s*<(${TAG_NAMES.join("|")})\\s*>`, "i");

/** The literal block `think_tags` emits. Reading is generous, writing is not:
 * one spelling out means a client only ever has to parse one. */
const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Longest run of leading characters that could still turn out to be an opening
 * tag: the longest tag plus its brackets, plus a little slack for the newline
 * or space a template may put in front of it. Once the buffer passes this
 * without matching, the answer has started and the scan is over.
 */
const MAX_SCAN = "<reasoning>".length + 8;

/** Whether `buffered` could still grow into an opening tag. */
function couldStillOpen(buffered: string): boolean {
  const s = buffered.replace(/^\s+/, "");
  if (!s) return true; // nothing but whitespace so far
  const lower = s.toLowerCase();
  return TAG_NAMES.some((name) => {
    const tag = `<${name}>`;
    return tag.startsWith(lower) || lower.startsWith(tag);
  });
}

/**
 * Lift a leading `<think>…</think>` out of the answer text into a reasoning part.
 *
 * Only at the very head of the content, and only when nothing structured was
 * parsed already: an upstream that filled `reasoning_content` has said where
 * its thinking is, and a `<think>` further down an answer is the model writing
 * about the tag, not using it.
 *
 * An UNTERMINATED tag stays text. A truncated answer that opened a thinking
 * block and never closed it is not a thinking block — turning the whole
 * remaining answer into reasoning would hand the client an empty response.
 */
export function liftThinkTags(content: ContentPart[]): ContentPart[] {
  if (content.some((p) => p.type === "reasoning")) return content;
  const i = content.findIndex((p) => p.type === "text");
  if (i < 0) return content;

  const part = content[i] as TextPart;
  const open = OPEN_RE.exec(part.text);
  if (!open) return content;

  const rest = part.text.slice(open[0].length);
  const close = new RegExp(`</${open[1]}\\s*>`, "i").exec(rest);
  if (!close) return content;

  const thought = rest.slice(0, close.index);
  const tail = rest.slice(close.index + close[0].length).replace(/^\s+/, "");
  const replacement: ContentPart[] = [{ type: "reasoning", text: thought.trim() }];
  if (tail) replacement.push({ ...part, text: tail });

  const out = [...content];
  out.splice(i, 1, ...replacement);
  return out;
}

/** Fold reasoning into the answer text as a `<think>` block. */
function inlineThinkTags(content: ContentPart[]): ContentPart[] {
  // A redacted block has no readable text by definition; there is nothing to
  // inline and an empty <think></think> would say something false.
  const thought = content
    .filter((p): p is ReasoningPart => p.type === "reasoning" && !p.redacted)
    .map((p) => p.text)
    .join("");
  const rest = content.filter((p) => p.type !== "reasoning");
  if (!thought) return rest;

  const block = `${OPEN_TAG}\n${thought}\n${CLOSE_TAG}\n\n`;
  const i = rest.findIndex((p) => p.type === "text");
  if (i < 0) return [{ type: "text", text: block }, ...rest];
  const out = [...rest];
  out[i] = { ...(rest[i] as TextPart), text: block + (rest[i] as TextPart).text };
  return out;
}

/** Apply a format to complete canonical content. */
export function applyThinkingFormat(content: ContentPart[], format: ThinkingFormat | undefined): ContentPart[] {
  if (!isThinkingFormatActive(format)) return content;
  const lifted = liftThinkTags(content);
  if (format === "none") return lifted.filter((p) => p.type !== "reasoning");
  if (format === "think_tags") return inlineThinkTags(lifted);
  // `reasoning` and `reasoning_content` differ only in what the renderer calls
  // the field, so the canonical content is already correct.
  return lifted;
}

/**
 * The streaming half of {@link liftThinkTags}.
 *
 * The opening tag arrives a character at a time like everything else, so the
 * scan holds text back until it can decide — at most a dozen characters, since
 * anything longer than the longest tag has already settled the question. Inside
 * a block it holds back only enough to recognise a closing tag split across two
 * deltas. Neither delay is perceptible; withholding the answer to wait for a
 * tag that might never arrive would be.
 */
async function* liftThinkTagsStream(events: AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
  let mode: "scan" | "inside" | "done" = "scan";
  let buffer = "";
  let closeTag = CLOSE_TAG;
  /**
   * The blank line a model writes between `</think>` and its answer is a
   * separator, not content, and the buffered path drops it. Here it usually
   * arrives in a LATER delta than the closing tag, so the suppression has to
   * survive across events -- otherwise the same response reaches the client
   * with a leading newline when it streams and without one when it does not.
   */
  let trimAfterBlock = false;

  for await (const ev of events) {
    // The upstream used a structured field: it has told us where its thinking
    // is and the text is just the answer.
    if (ev.type === "reasoning_start" || ev.type === "reasoning_delta" || ev.type === "reasoning_stop") {
      if (mode === "scan" && buffer) yield { type: "text_delta", text: buffer };
      buffer = "";
      mode = "done";
      yield ev;
      continue;
    }

    // `start` is metadata and is ALWAYS the first event of a stream. Treating
    // it as the answer beginning would end the scan before a single character
    // of text had arrived -- which is to say, on every stream there is.
    if (ev.type === "start") {
      yield ev;
      continue;
    }

    if (ev.type !== "text_delta") {
      // Anything else does end it: a tool call means the answer's structure has
      // begun and no opening tag is coming. A stream that dies mid-block still
      // closes it, so the client is not left with a block that never ended.
      if (mode === "scan" && buffer) yield { type: "text_delta", text: buffer };
      else if (mode === "inside") {
        if (buffer) yield { type: "reasoning_delta", text: buffer };
        yield { type: "reasoning_stop" };
      }
      buffer = "";
      mode = "done";
      yield ev;
      continue;
    }

    if (mode === "done") {
      if (trimAfterBlock) {
        const trimmed = ev.text.replace(/^\s+/, "");
        if (!trimmed) continue; // still only the separator
        trimAfterBlock = false;
        yield { type: "text_delta", text: trimmed };
        continue;
      }
      yield ev;
      continue;
    }

    buffer += ev.text;

    if (mode === "scan") {
      const open = OPEN_RE.exec(buffer);
      if (open) {
        closeTag = `</${open[1]}>`;
        buffer = buffer.slice(open[0].length);
        mode = "inside";
        yield { type: "reasoning_start" };
      } else if (!couldStillOpen(buffer) || buffer.length > MAX_SCAN) {
        yield { type: "text_delta", text: buffer };
        buffer = "";
        mode = "done";
        continue;
      } else {
        continue; // still undecided; hold
      }
    }

    // mode === "inside"
    const at = buffer.toLowerCase().indexOf(closeTag.toLowerCase());
    if (at >= 0) {
      const thought = buffer.slice(0, at);
      const tail = buffer.slice(at + closeTag.length).replace(/^\s+/, "");
      if (thought) yield { type: "reasoning_delta", text: thought };
      yield { type: "reasoning_stop" };
      buffer = "";
      mode = "done";
      // Whitespace after the tag is consumed here when it came in the same
      // delta, and by `trimAfterBlock` when it has not arrived yet.
      trimAfterBlock = tail.length === 0;
      if (tail) yield { type: "text_delta", text: tail };
      continue;
    }
    // Hold back just enough that a closing tag split across two deltas is still
    // recognised when the second half lands.
    const hold = closeTag.length - 1;
    if (buffer.length > hold) {
      const safe = buffer.slice(0, buffer.length - hold);
      buffer = buffer.slice(safe.length);
      yield { type: "reasoning_delta", text: safe };
    }
  }

  // The generator ended without a terminal event (a truncated relay).
  if (mode === "scan" && buffer) yield { type: "text_delta", text: buffer };
  else if (mode === "inside") {
    if (buffer) yield { type: "reasoning_delta", text: buffer };
    yield { type: "reasoning_stop" };
  }
}

/** The streaming half of {@link inlineThinkTags}. */
async function* inlineThinkTagsStream(events: AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
  let open = false;
  for await (const ev of events) {
    if (ev.type === "reasoning_start") continue; // deferred until there is text
    if (ev.type === "reasoning_delta") {
      if (!open) {
        open = true;
        yield { type: "text_delta", text: `${OPEN_TAG}\n` };
      }
      yield { type: "text_delta", text: ev.text };
      continue;
    }
    if (ev.type === "reasoning_stop") {
      if (open) {
        open = false;
        yield { type: "text_delta", text: `\n${CLOSE_TAG}\n\n` };
      }
      continue;
    }
    // Close an open block before anything else goes out, so the tags can never
    // straddle a tool call or a finish.
    if (open) {
      open = false;
      yield { type: "text_delta", text: `\n${CLOSE_TAG}\n\n` };
    }
    yield ev;
  }
  if (open) yield { type: "text_delta", text: `\n${CLOSE_TAG}\n\n` };
}

/** Apply a format to a live canonical event stream. */
export function withThinkingFormat(
  events: AsyncGenerator<StreamEvent>,
  format: ThinkingFormat | undefined,
): AsyncGenerator<StreamEvent> {
  if (!isThinkingFormatActive(format)) return events;
  const lifted = liftThinkTagsStream(events);
  if (format === "none") return withoutReasoning(lifted);
  if (format === "think_tags") return inlineThinkTagsStream(lifted);
  return lifted;
}
