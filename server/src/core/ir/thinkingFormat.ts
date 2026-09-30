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

export const THINKING_FORMATS = [
  "original",
  "reasoning_content",
  "reasoning",
  "think_tags",
  "none",
] as const;

/** Whether a format asks for anything at all. `original` and absence do not. */
export function isThinkingFormatActive(f: ThinkingFormat | undefined): f is Exclude<ThinkingFormat, "original"> {
  return f != null && f !== "original";
}

/**
 * What a tag NAME has to look like to mean "reasoning".
 *
 * `think` is the DeepSeek-R1 convention every distill and most open-weight
 * reasoners copied; `thinking`, `thought` and `reasoning` show up in
 * prompt-templated variants, and templates wrap the stem freely
 * (`chain_of_thought`, `thinking_process`, `deep_think`). Recognising the stem
 * instead of a fixed list is the difference between reading the next model's
 * block and delivering it to the client as the ANSWER, because a name this
 * scanner does not know is a block it never lifts.
 *
 * Names like `analysis` are deliberately NOT included: structured-answer
 * wrappers use them, and a tag at the head of a real answer is not thinking.
 */
const REASONING_NAME = /^[a-z_]*(?:think|reason|thought)[a-z_]*$/;

/** Longest tag name worth recognising. Bounds the streaming hold below. */
const MAX_NAME = 24;

/** Whitespace a template may put AROUND a tag: `<think >`, `< think>`, or a
 * newline before the bracket. `\s` in JavaScript already covers the space, the
 * tab, the newline, NBSP, the ideographic space and the BOM. */
const PAD = "\\s*";

/**
 * Zero-width characters a model may emit INSIDE a name without meaning to
 * change it. Invisible in a client, fatal to an exact match -- and a tag
 * Hydrogen does not recognise is a block the client renders as the answer.
 */
const ZW = "[\\u200b-\\u200d\\u2060]*";
const ZW_RE = new RegExp(ZW, "g");

/** One name letter, with the zero-width padding allowed beside it. */
const NAME_CHAR = `[a-z_]${ZW}`;
/** A whole name body, bounded so a pathological tag cannot hold the scan. */
const NAME_BODY = `(?:${NAME_CHAR}){1,${MAX_NAME}}`;

const OPEN_RE = new RegExp(`^${PAD}<${ZW}(${NAME_BODY})${PAD}>`, "i");

/**
 * The close tag accepts ANY reasoning-ish name, whichever one opened the block.
 *
 * Models mix them constantly: opening with one spelling and closing with
 * another is ordinary behaviour, and the name a model closes with is not a
 * promise about what it opened with. Binding the close to the opening name
 * meant Hydrogen recognised NO close at all, so the block was never lifted and
 * the whole answer travelled to the client as raw tagged text. Reading
 * generously is the point of this scanner; nothing is gained by insisting the
 * two names agree.
 *
 * Global because {@link findClose} walks it; that function owns `lastIndex`.
 */
const CLOSE_RE = new RegExp(`</${PAD}(${NAME_BODY})${PAD}>`, "gi");

/** Whether a matched name is one of the spellings that means reasoning. */
function isReasoningName(raw: string): boolean {
  return REASONING_NAME.test(raw.replace(ZW_RE, "").toLowerCase());
}

/**
 * An operator-declared boundary pair, for a model whose trace no scanner could
 * guess from shape: the literal text that opens the block and the literal text
 * that ends it.
 *
 * This is the escape hatch every serious implementation has, and for the same
 * reason. vLLM exposes it as `--reasoning-config` (`reasoning_start_str` /
 * `reasoning_end_str`), Open WebUI as a configurable "reasoning tag pair". It is
 * the ONLY way to cover a model that does not delimit with an angle-bracket tag
 * at all -- GPT-OSS's harmony channels (`<|channel|>analysis<|message|>` ...
 * `<|channel|>final<|message|>`) are the standard example -- because no
 * name-shape rule can recognise a marker that is not tag-shaped.
 *
 * Declaring the pair is itself a request to find it: a service that declares
 * boundaries has its thinking separated even while its format is `original`,
 * and the format then only decides how that thinking is presented.
 */
export interface ThinkingDelimiters {
  /** Literal text that starts the thinking block. */
  open: string;
  /** Literal text that ends it, and the point the answer starts at. */
  close: string;
}

/** How one response's block boundaries are found. */
interface TagMatcher {
  /** Length of an opening tag at the head of `text`, or undefined. */
  open(text: string): number | undefined;
  /** The first close-tag candidate in `text`, quoted or not. */
  close(text: string): { index: number; length: number } | undefined;
  /** Whether `buffered` could still grow into an opening tag. */
  pending(buffered: string): boolean;
}

/** The built-in rules: a reasoning-ish tag name, read generously. */
const BUILTIN_MATCHER: TagMatcher = {
  open(text) {
    const m = OPEN_RE.exec(text);
    return m && isReasoningName(m[1]) ? m[0].length : undefined;
  },
  close(text) {
    CLOSE_RE.lastIndex = 0;
    for (let m = CLOSE_RE.exec(text); m; m = CLOSE_RE.exec(text)) {
      if (isReasoningName(m[1])) return { index: m.index, length: m[0].length };
    }
    return undefined;
  },
  pending: couldStillOpen,
};

/** The operator's pair, matched literally. Exactness is the point: nothing is
 * guessed, and the head is held only while it could still become that exact
 * opening string. */
function declaredMatcher(pair: ThinkingDelimiters): TagMatcher {
  const open = pair.open.replace(ZW_RE, "");
  const close = pair.close;
  return {
    open(text) {
      const pad = /^\s*/.exec(text)?.[0].length ?? 0;
      return text.slice(pad).replace(ZW_RE, "").startsWith(open) ? pad + open.length : undefined;
    },
    close(text) {
      const index = text.indexOf(close);
      return index < 0 ? undefined : { index, length: close.length };
    },
    pending(buffered) {
      const s = buffered.replace(ZW_RE, "").replace(/^\s+/, "");
      if (!s) return buffered.length <= MAX_PAD;
      return s.length <= open.length && open.startsWith(s);
    },
  };
}

/** The matcher one response is scanned with. */
function matcherFor(delimiters: ThinkingDelimiters | undefined): TagMatcher {
  return delimiters ? declaredMatcher(delimiters) : BUILTIN_MATCHER;
}

/** The literal block `think_tags` emits. Reading is generous, writing is not:
 * one spelling out means a client only ever has to parse one. */
const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Longest run of NON-padding characters that could still turn out to be an
 * opening tag. The name is recognised by shape rather than from a list, so any
 * letters could in principle grow into a reasoning-ish name; this is the
 * backstop that keeps the streaming hold bounded. Pure padding is bounded
 * separately, by MAX_PAD.
 */
const MAX_SCAN = MAX_NAME + 8;

/** How much invisible padding may precede a tag before it counts as content.
 * Generous on purpose: a template's leading newlines are not the answer
 * beginning, and a purely-padding run is the only thing this bounds. */
const MAX_PAD = 512;

/**
 * Whether `buffered` could still grow into an opening tag.
 *
 * Anything this holds back, OPEN_RE can still accept, and the two agree on what
 * counts as padding: zero-width characters are ignored, whitespace around a tag
 * does not settle anything, and a long run of leading newlines is a chat
 * template rather than the answer beginning. What DOES settle it is the answer
 * starting: a non-`<` character, a name character that cannot be part of a tag
 * (a space followed by more text means attributes), or a name that has already
 * closed -- at which point OPEN_RE has had its say.
 */
function couldStillOpen(buffered: string): boolean {
  const compact = buffered.replace(ZW_RE, "").replace(/^\s+/, "");
  if (!compact) return buffered.length <= MAX_PAD; // padding only so far
  if (compact.length > MAX_SCAN) return false;
  if (compact[0] !== "<") return false;
  const body = compact.slice(1);
  if (body.includes(">")) return false; // already closed: OPEN_RE decided it
  return /^[a-z_]*$/i.test(body.replace(/\s+$/, ""));
}

/**
 * Whether `index` sits inside a Markdown code span or fenced block.
 *
 * The close tag has to be found in the model's OWN WORDS, and a model reasoning
 * about these tags writes them down: a close tag quoted in backticks, or a
 * whole example of the block inside a fence. Those are quotations, not the end
 * of the thinking. Taking one as the end is how the answer ends up inside the
 * thinking region -- everything the model wrote after that point, the rest of
 * its reasoning and its answer, is delivered as ordinary answer text, and a
 * client that renders reasoning separately shows the reasoning as the answer.
 *
 * This is the judgement the opening scan already makes in spirit ("a tag
 * further down an answer is the model writing about the tag, not using it"),
 * applied where a wrong answer is expensive rather than merely untidy.
 */
function insideCode(text: string, index: number): boolean {
  let fence: string | undefined; // the marker character of the open fence
  let fenceLength = 0;
  let span = 0; // backticks in the code span open at this point, 0 = none
  let lineStart = 0;
  let i = 0;
  while (i < index) {
    const ch = text[i];
    if (ch === "\n") {
      lineStart = i + 1;
      span = 0; // a span cannot cross a line
      i++;
      continue;
    }
    if (ch !== "`" && ch !== "~") {
      i++;
      continue;
    }
    let run = 1;
    while (i + run < text.length && text[i + run] === ch) run++;
    // A fence opens and closes on a line of its own (three or more markers).
    const atLineStart = text.slice(lineStart, i).trim() === "";
    if (run >= 3 && atLineStart) {
      if (fence === undefined) {
        fence = ch;
        fenceLength = run;
      } else if (fence === ch && run >= fenceLength) {
        fence = undefined;
      }
    } else if (fence === undefined && ch === "`") {
      // Inside a span, only a run of the SAME length closes it.
      span = span === 0 ? run : span === run ? 0 : span;
    }
    i += run;
  }
  return fence !== undefined || span !== 0;
}

/**
 * The first close tag the model is USING rather than quoting: the first one
 * {@link insideCode} does not place inside a code span or fence.
 *
 * A block whose only close tags are quotations is left unterminated, which
 * every caller already treats as "this was the answer text" -- the safe
 * direction, since it loses a thinking block rather than the answer.
 */
/**
 * Whether a candidate is wrapped in backticks on BOTH sides, the inline way a
 * model writes a tag it is only talking about.
 *
 * Checked separately from {@link insideCode} because span pairing there is
 * CommonMark-exact while a model's reasoning is not Markdown: an unmatched
 * backtick run still marks its neighbour as a quotation here. Both sides are
 * required, so a real end followed by an answer that opens with a code fence
 * is never mistaken for a quotation.
 */
function backtickQuoted(text: string, index: number, length: number): boolean {
  return text[index - 1] === "`" && text[index + length] === "`";
}

function findClose(text: string, matcher: TagMatcher): { index: number; length: number } | undefined {
  let from = 0;
  while (from <= text.length) {
    const found = matcher.close(text.slice(from));
    if (!found) return undefined;
    const at = from + found.index;
    // Quoted candidates are skipped: a later one may be the real end.
    if (!insideCode(text, at) && !backtickQuoted(text, at, found.length)) return { index: at, length: found.length };
    from = at + found.length;
  }
  return undefined;
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
export function liftThinkTags(content: ContentPart[], delimiters?: ThinkingDelimiters): ContentPart[] {
  if (content.some((p) => p.type === "reasoning")) return content;
  const i = content.findIndex((p) => p.type === "text");
  if (i < 0) return content;

  const matcher = matcherFor(delimiters);
  const part = content[i] as TextPart;
  const at = matcher.open(part.text);
  if (at === undefined) return content;

  const rest = part.text.slice(at);
  const close = findClose(rest, matcher);
  if (!close) return content;

  const thought = rest.slice(0, close.index);
  const tail = rest.slice(close.index + close.length).replace(/^\s+/, "");
  const replacement: ContentPart[] = thought.trim() ? [{ type: "reasoning", text: thought.trim() }] : [];
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
export function applyThinkingFormat(
  content: ContentPart[],
  format: ThinkingFormat | undefined,
  delimiters?: ThinkingDelimiters,
): ContentPart[] {
  if (!isThinkingFormatActive(format) && !delimiters) return content;
  const lifted = liftThinkTags(content, delimiters);
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
 * anything longer than the longest tag has already settled the question.
 *
 * Once the opening tag matches, the candidate block is held WHOLE: nothing is
 * emitted until the closing tag proves it really is thinking. That is forced by
 * {@link liftThinkTags} -- a `reasoning_delta` already sent cannot be recalled,
 * and a block that never closes is the answer text, not a thought. When the
 * closing tag lands the held thought is replayed in small deltas (the bytes are
 * already in hand, so clients still render it progressively); when the stream
 * ends or a non-text event arrives first, the whole held run goes out as plain
 * text, opening tag included. An upstream that fills a structured reasoning
 * field never reaches this scanner, so its thinking still streams live.
 */
async function* liftThinkTagsStream(events: AsyncGenerator<StreamEvent>, delimiters?: ThinkingDelimiters): AsyncGenerator<StreamEvent> {
  const matcher = matcherFor(delimiters);
  /** Chunk size for replaying a held thought, so clients still see deltas. */
  const REPLAY_CHUNK = 24;
  let mode: "scan" | "inside" | "done" = "scan";
  /** Raw text held since the start; while `inside` it still carries the open tag. */
  let held = "";
  /** Offset of the first thought character, i.e. just past the opening tag. */
  let thoughtFrom = 0;
  /**
   * The blank line a model writes between a closing tag and its answer is a
   * separator, not content, and the buffered path drops it. Here it usually
   * arrives in a LATER delta than the closing tag, so the suppression has to
   * survive across events -- otherwise the same response reaches the client
   * with a leading newline when it streams and without one when it does not.
   */
  let trimAfterBlock = false;

  /** Release whatever is held as ordinary answer text and stop scanning. */
  function* asText(): Generator<StreamEvent> {
    if (held) yield { type: "text_delta", text: held };
    held = "";
    mode = "done";
  }

  for await (const ev of events) {
    // The upstream used a structured field: it has told us where its thinking
    // is and the text is just the answer.
    if (ev.type === "reasoning_start" || ev.type === "reasoning_delta" || ev.type === "reasoning_stop") {
      yield* asText();
      yield ev;
      continue;
    }

    // `start` is metadata and is ALWAYS the first event of a stream. Treating
    // it as the answer beginning would end the scan before a single character
    // of text had arrived -- which is to say, on every stream there is.
    if (ev.type === "start" || ev.type === "usage") {
      yield ev;
      continue;
    }

    if (ev.type !== "text_delta") {
      // Anything else does end it: a tool call means the answer's structure has
      // begun and no opening tag is coming, and a stream that dies mid-block
      // never closed one. Either way what is held was never a thought.
      yield* asText();
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

    held += ev.text;

    if (mode === "scan") {
      const at = matcher.open(held);
      if (at !== undefined) {
        thoughtFrom = at;
        mode = "inside";
        // Fall through: one delta may carry the opening AND the closing tag.
      } else if (!matcher.pending(held)) {
        yield { type: "text_delta", text: held };
        held = "";
        mode = "done";
        continue;
      } else {
        continue; // still undecided; hold
      }
    }

    // mode === "inside"
    const rest = held.slice(thoughtFrom);
    const close = findClose(rest, matcher);
    if (!close) continue; // still buffering; emit nothing yet
    const at = thoughtFrom + close.index;
    const thought = held.slice(thoughtFrom, at);
    const tail = held.slice(at + close.length).replace(/^\s+/, "");
    yield { type: "reasoning_start" };
    for (let i = 0; i < thought.length; i += REPLAY_CHUNK) {
      yield { type: "reasoning_delta", text: thought.slice(i, i + REPLAY_CHUNK) };
    }
    yield { type: "reasoning_stop" };
    held = "";
    mode = "done";
    // Whitespace after the tag is consumed here when it came in the same
    // delta, and by `trimAfterBlock` when it has not arrived yet.
    trimAfterBlock = tail.length === 0;
    if (tail) yield { type: "text_delta", text: tail };
  }

  // The generator ended without a terminal event (a truncated relay).
  yield* asText();
}

/** The streaming half of {@link inlineThinkTags}. */
async function* inlineThinkTagsStream(events: AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
  let open = false;
  for await (const ev of events) {
    if (ev.type === "usage") { yield ev; continue; }
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
  delimiters?: ThinkingDelimiters,
): AsyncGenerator<StreamEvent> {
  if (!isThinkingFormatActive(format) && !delimiters) return events;
  const lifted = liftThinkTagsStream(events, delimiters);
  if (format === "none") return withoutReasoning(lifted);
  if (format === "think_tags") return inlineThinkTagsStream(lifted);
  return lifted;
}
