import type { ContentPart, StopReason, TextPart } from "./content";
import { withoutReasoning, type StreamEvent } from "./stream";
import { UpstreamStreamError } from "./toolArguments";
import { ThinkingQuotes, type ThinkingQuoteKind } from "./thinkingQuotes";

/** Client presentation only. Selecting an output format NEVER enables parsing.
 * Decode the upstream's declared textual convention before applying a format.
 * `reasoning` / `reasoning_content` differ only in the Chat Completions renderer;
 * other protocols keep their native structured reasoning fields. */
export type ThinkingFormat = "original" | "reasoning_content" | "reasoning" | "think_tags" | "none";

export const THINKING_FORMATS = [
  "original", "reasoning_content", "reasoning", "think_tags", "none",
] as const;

export function isThinkingFormatActive(f: ThinkingFormat | undefined): f is Exclude<ThinkingFormat, "original"> {
  return f != null && f !== "original";
}

/** Exact, case-sensitive strings. Nothing, including zero-width characters, is
 * removed or normalized. Configuration schemas must validate a nonempty pair. */
export interface ThinkingDelimiters {
  open: string;
  close: string;
}

/** Explicit upstream decoding, independent of client presentation.
 *
 * Built-in think tags skip confirmed quoted examples (backticks, fences and
 * paired prose quotes). A possible close inside a quotation gets at most 4096
 * code units of lookahead; unresolved long ambiguity errors rather than leaking
 * reasoning. Incomplete quotations can recover at a line/end boundary. Custom
 * delimiters remain literal protocol strings; prefer native fields when possible.
 * Only the initial text run is scanned, never a tag later in an answer. Native
 * reasoning encountered first disables scanning and retains its signatures.
 *
 * At most 512 whitespace code units may precede an opening delimiter. Exceeding
 * this bound fails closed, regardless of chunk partition. If a custom opener
 * itself starts with whitespace it must match literally from offset zero (no
 * additional padding is guessed). Reasoning bytes are preserved verbatim; the
 * whitespace separator immediately after the close is discarded.
 *
 * A matched opener commits all subsequent bytes to reasoning until its exact
 * close. An unclosed block errors by default; `reasoning` retains it as reasoning
 * only. An incomplete opener or a structural interruption always errors.
 * Stream token logprobs are omitted while decoding is enabled: their alignment
 * no longer matches the stripped text and their tokens may expose reasoning. */
export type ThinkingParser = {
  mode: "off" | "think_tags" | "custom";
  delimiters?: ThinkingDelimiters;
  unterminated?: "error" | "reasoning";
};

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
const MAX_PADDING = 512;
const SPACE = /\s/;
const UNTERMINATED = "Upstream thinking block is unterminated";
const INCOMPLETE_OPEN = "Upstream thinking opening delimiter is incomplete";
const INTERRUPTED = "Upstream thinking block was interrupted";
const EXCESS_PADDING = "Upstream thinking prefix exceeds the 512-character padding limit";

export const THINKING_QUOTE_LOOKAHEAD = 4096;
const AMBIGUOUS = "Upstream thinking boundary is ambiguous: quotation lookahead exceeds the 4096-character limit; use native reasoning fields or an explicit custom delimiter";

type ActiveParser = { pair: ThinkingDelimiters; unterminated: "error" | "reasoning"; quoted: boolean };

function activeParser(parser: ThinkingParser | undefined): ActiveParser | undefined {
  if (!parser || parser.mode === "off") return undefined;
  const pair = parser.mode === "think_tags" ? { open: OPEN_TAG, close: CLOSE_TAG } : parser.delimiters;
  // The parent schema owns validation. Also guard direct/programmatic callers
  // against an empty delimiter (which cannot make progress in a literal parser).
  if (!pair || !pair.open || !pair.close) throw new TypeError("Thinking parser requires nonempty opening and closing delimiters");
  return { pair, unterminated: parser.unterminated ?? "error", quoted: parser.mode === "think_tags" };
}

/** KMP prefix table: repeated prefixes in a custom close cannot cause rescans. */
function prefixTable(pattern: string): number[] {
  const table = new Array<number>(pattern.length).fill(0);
  for (let i = 1, j = 0; i < pattern.length; i++) {
    while (j && pattern[i] !== pattern[j]) j = table[j - 1];
    if (pattern[i] === pattern[j]) j++;
    table[i] = j;
  }
  return table;
}

/** Shared state machine for buffered parts and streamed deltas. Literal KMP
 * matching is augmented by bounded quotation lookahead for built-in think tags.
 * Persistent storage is O(open + close + MAX_PADDING + THINKING_QUOTE_LOOKAHEAD),
 * never the whole thought. Each code unit is examined a constant number of times. */
class ThinkingDecoder {
  private phase: "opening" | "reasoning" | "separator" | "pass" | "failed" = "opening";
  private padding = "";
  private opening = 0;
  private closing = 0;
  private readonly table: number[];
  private readonly allowPadding: boolean;
  private readonly quotes = new ThinkingQuotes();
  private pendingQuote: { kind: ThinkingQuoteKind; tail: string[]; size: number; confirmed: boolean; closing: number } | undefined;
  matched = false;
  error: string | undefined;

  constructor(private readonly config: ActiveParser) {
    this.table = prefixTable(config.pair.close);
    this.allowPadding = !SPACE.test(config.pair.open[0]);
  }

  get candidate(): boolean { return this.opening > 0 || this.phase === "reasoning"; }

  private fail(message: string): void {
    this.error = message;
    this.phase = "failed";
    this.padding = "";
    this.opening = 0;
    this.closing = 0;
    this.pendingQuote = undefined;
  }

  /** Release a recovered candidate's tail only after its boundary is decided. */
  private *recoverQuote(): Generator<StreamEvent> {
    const tail = this.pendingQuote!.tail.join("");
    this.pendingQuote = undefined;
    this.phase = "separator";
    yield { type: "reasoning_stop" };
    yield* this.text(tail);
  }

  *text(text: string): Generator<StreamEvent> {
    if (this.phase === "failed") return;
    const { open, close } = this.config.pair;
    let i = 0;
    if (this.phase === "opening") {
      while (i < text.length) {
        const ch = text[i];
        if (!this.opening && this.allowPadding && SPACE.test(ch)) {
          if (this.padding.length === MAX_PADDING) { this.fail(EXCESS_PADDING); return; }
          this.padding += ch;
          i++;
          continue;
        }
        if (ch !== open[this.opening]) {
          const head = this.padding + open.slice(0, this.opening);
          this.padding = "";
          this.opening = 0;
          this.phase = "pass";
          if (head) yield { type: "text_delta", text: head };
          yield { type: "text_delta", text: text.slice(i) };
          return;
        }
        this.opening++;
        i++;
        if (this.opening === open.length) {
          this.matched = true;
          this.opening = 0;
          this.padding = "";
          this.phase = "reasoning";
          yield { type: "reasoning_start" };
          break;
        }
      }
    }
    if (this.phase === "reasoning") {
      const output: string[] = [];
      const thought = (piece: string): void => {
        if (!piece) return;
        output.push(piece);
        if (this.config.quoted) this.quotes.text(piece);
      };
      while (i < text.length) {
        if (this.pendingQuote) {
          const pending = this.pendingQuote;
          const ch = text[i];
          const proof = this.quotes.before(ch);
          if (proof.closed === pending.kind) {
            if (pending.kind === "fence") pending.confirmed = true;
            else {
              // The proof character is NOT part of the closed quotation. It
              // may be '<' beginning the actual terminator; process it again.
              output.push(close + pending.tail.join(""));
              this.pendingQuote = undefined;
              continue;
            }
          }
          if (proof.expired && pending.kind !== "fence") {
            if (output.length) { yield { type: "reasoning_delta", text: output.join("") }; output.length = 0; }
            yield* this.recoverQuote();
            // recoverQuote already emitted reasoning_stop; process the current
            // newline and remaining chunk as answer without a second stop.
            yield* this.text(text.slice(i));
            return;
          }
          if (pending.size === THINKING_QUOTE_LOOKAHEAD) {
            this.fail(AMBIGUOUS);
            throw new UpstreamStreamError(AMBIGUOUS);
          }
          // A closed fence alone is ambiguous: it could be the answer's opening
          // fence. Keep the earliest candidate until a later unquoted terminator
          // confirms it, rather than swallowing an entire code-only answer.
          if (pending.confirmed && !this.quotes.kind) {
            while (pending.closing && ch !== close[pending.closing]) pending.closing = this.table[pending.closing - 1];
            if (ch === close[pending.closing]) pending.closing++;
          } else pending.closing = 0;
          pending.tail.push(ch);
          pending.size++;
          const closed = this.quotes.push(ch);
          i++;
          if (pending.closing === close.length) {
            output.push(close + pending.tail.join("").slice(0, -close.length));
            this.pendingQuote = undefined;
            this.phase = "separator";
            break;
          }
          if (closed === pending.kind && pending.kind === "prose") {
            output.push(close + pending.tail.join(""));
            this.pendingQuote = undefined;
          }
          continue;
        }
        // Scan each committed reasoning fragment once, including quotation
        // state. Never rescan the growing response or treat a chunk end as EOF.
        if (!this.closing && text[i] !== close[0]) {
          const next = text.indexOf(close[0], i);
          const end = next < 0 ? text.length : next;
          thought(text.slice(i, end));
          i = end;
          continue;
        }
        const ch = text[i++];
        while (this.closing && ch !== close[this.closing]) {
          const fallback = this.table[this.closing - 1];
          thought(close.slice(0, this.closing - fallback));
          this.closing = fallback;
        }
        if (ch === close[this.closing]) this.closing++;
        else thought(ch);
        if (this.closing === close.length) {
          this.closing = 0;
          if (this.config.quoted) this.quotes.before(close[0]);
          const kind = this.config.quoted ? this.quotes.kind : undefined;
          if (kind) {
            this.quotes.text(close);
            this.pendingQuote = { kind, tail: [], size: 0, confirmed: false, closing: 0 };
            continue;
          }
          this.phase = "separator";
          break;
        }
      }
      if (output.length) yield { type: "reasoning_delta", text: output.join("") };
      if (this.phase === "separator") yield { type: "reasoning_stop" };
    }
    if (this.phase === "separator") {
      while (i < text.length && SPACE.test(text[i])) i++;
      if (i < text.length) this.phase = "pass";
    }
    if (this.phase === "pass" && i < text.length) yield { type: "text_delta", text: text.slice(i) };
  }

  /** End of text, either terminal or interrupted by structured content. */
  *end(interrupted = false): Generator<StreamEvent> {
    if (this.phase === "failed") return;
    if (this.pendingQuote) {
      if (interrupted) {
        this.fail(INTERRUPTED);
        yield { type: "reasoning_stop" };
        return;
      }
      const proof = this.quotes.before(undefined);
      if (proof.closed === this.pendingQuote.kind && this.pendingQuote.kind !== "fence") {
        yield { type: "reasoning_delta", text: this.config.pair.close + this.pendingQuote.tail.join("") };
        this.pendingQuote = undefined;
      } else {
        // At actual response end an unconfirmed quotation cannot indefinitely
        // hide a real boundary. This also rescues an answer opening a bare fence.
        yield* this.recoverQuote();
        return;
      }
    }
    if (this.phase === "reasoning") {
      // A pending closing prefix belongs to reasoning, never to the answer.
      if (this.closing) yield { type: "reasoning_delta", text: this.config.pair.close.slice(0, this.closing) };
      this.closing = 0;
      yield { type: "reasoning_stop" };
      if (interrupted || this.config.unterminated === "error") {
        this.fail(interrupted ? INTERRUPTED : UNTERMINATED);
        return;
      }
    } else if (this.phase === "opening") {
      if (this.opening) { this.fail(interrupted ? INTERRUPTED : INCOMPLETE_OPEN); return; }
      if (this.padding) yield { type: "text_delta", text: this.padding };
      this.padding = "";
    }
    this.phase = "pass";
  }
}

/** Decode an explicitly declared initial textual thinking block. Consecutive
 * text parts are treated exactly like stream chunks. Unchanged responses retain
 * array/object identity; unrelated parts and native reasoning stay in order. */
export function decodeThinking(content: ContentPart[], parser?: ThinkingParser, stopReason: StopReason = "stop"): ContentPart[] {
  const config = activeParser(parser);
  if (!config) return content;
  const decoder = new ThinkingDecoder(config);
  const out: ContentPart[] = [];
  let thought: string[] = [];
  const accept = (ev: StreamEvent, source?: TextPart): void => {
    if (ev.type === "reasoning_delta") thought.push(ev.text);
    else if (ev.type === "reasoning_stop") {
      if (thought.length) out.push({ type: "reasoning", text: thought.join("") });
      thought = [];
    } else if (ev.type === "text_delta") {
      out.push(source ? (source.text === ev.text ? source : { ...source, text: ev.text }) : { type: "text", text: ev.text });
    }
  };
  for (const part of content) {
    if (part.type === "text") {
      for (const ev of decoder.text(part.text)) accept(ev, part);
    } else {
      // No textual candidate yet: a native field/tool is authoritative and
      // switches the complete response to identity, just as on the stream.
      if (!decoder.matched && !decoder.candidate && !decoder.error) return content;
      for (const ev of decoder.end(true)) accept(ev);
      out.push(part);
    }
    if (decoder.error) throw new UpstreamStreamError(decoder.error);
  }
  // Only a normal stop proves that an ambiguous quoted terminator can recover.
  // Token limits, filtering, pauses, tool handoffs and unknown stops do not.
  for (const ev of decoder.end(stopReason !== "stop")) accept(ev);
  if (decoder.error) throw new UpstreamStreamError(decoder.error);
  return decoder.matched ? out : content;
}

/** Compatibility spelling; calling it is an explicit request to decode tags. */
export function liftThinkTags(content: ContentPart[], delimiters?: ThinkingDelimiters): ContentPart[] {
  return decodeThinking(content, delimiters ? { mode: "custom", delimiters } : { mode: "think_tags" });
}

/** Absent/off is identity, including the generator object itself. */
export function decodeThinkingStream(events: AsyncGenerator<StreamEvent>, parser?: ThinkingParser): AsyncGenerator<StreamEvent> {
  const config = activeParser(parser);
  return config ? decodeStream(events, config) : events;
}

async function* decodeStream(events: AsyncGenerator<StreamEvent>, config: ActiveParser): AsyncGenerator<StreamEvent> {
  const decoder = new ThinkingDecoder(config);
  let finished = false;
  try {
    for await (const ev of events) {
      // Accounting and response identity are transparent, including after an
      // error. Keep draining to obtain the upstream's terminal usage/failure.
      if (ev.type === "start" || ev.type === "usage") { yield ev; continue; }
      // Completion parsers emit these BEFORE the corresponding text chunk.
      // They must neither end the initial scan nor leak raw reasoning tokens.
      if (ev.type === "logprobs") continue;
      if (ev.type === "finish") {
        // Only a clean response boundary can resolve an ambiguous quotation as
        // an answer. A failed/truncated response must not promote its held tail.
        yield* decoder.end(ev.incomplete === true || ev.error !== undefined || ev.stopReason !== "stop");
        yield decoder.error ? { ...ev, error: ev.error ?? decoder.error } : ev;
        finished = true;
        continue;
      }
      if (decoder.error) continue;
      if (ev.type === "text_delta") yield* decoder.text(ev.text);
      else {
        yield* decoder.end(true);
        if (!decoder.error) yield ev;
      }
    }
  } catch (error) {
    // Never expose generated text through an exception from a broken candidate.
    // Errors outside a candidate remain the upstream/transport's responsibility.
    if (!decoder.candidate && !decoder.error) throw error;
    yield* decoder.end(true);
  }
  if (!finished) {
    // Iterator EOF without a terminal event is not evidence of a clean stop.
    yield* decoder.end(true);
    if (decoder.error) yield { type: "finish", stopReason: null, incomplete: true, error: decoder.error };
  }
}

/** Inline each readable reasoning block in place, never hoisting it past tools
 * or other content. Dropping/formatting reasoning is intentional presentation;
 * original and native-field modes preserve signatures and opaque content. */
function inlineThinkTags(content: ContentPart[]): ContentPart[] {
  if (!content.some(p => p.type === "reasoning")) return content;
  const out: ContentPart[] = [];
  let pending: string[] = [];
  for (const part of content) {
    if (part.type === "reasoning") {
      if (!part.redacted && part.text) pending.push(`${OPEN_TAG}\n${part.text}\n${CLOSE_TAG}\n\n`);
      continue;
    }
    if (pending.length) {
      const block = pending.join("");
      pending = [];
      if (part.type === "text") { out.push({ ...part, text: block + part.text }); continue; }
      out.push({ type: "text", text: block });
    }
    out.push(part);
  }
  if (pending.length) out.push({ type: "text", text: pending.join("") });
  return out;
}

/** Pure presentation. Call decodeThinking with an explicit parser first. */
export function applyThinkingFormat(
  content: ContentPart[],
  format: ThinkingFormat | undefined,
): ContentPart[] {
  if (format === "none") return content.filter(p => p.type !== "reasoning");
  if (format === "think_tags") return inlineThinkTags(content);
  return content;
}

async function* inlineThinkTagsStream(events: AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
  let open = false;
  let redacted = false;
  const close = (): StreamEvent => ({ type: "text_delta", text: `\n${CLOSE_TAG}\n\n` });
  for await (const ev of events) {
    if (ev.type === "start" || ev.type === "usage") { yield ev; continue; }
    if (ev.type === "reasoning_start") {
      if (open) { yield close(); open = false; }
      redacted = ev.redacted === true;
      continue;
    }
    if (ev.type === "reasoning_delta") {
      if (redacted || !ev.text) continue;
      if (!open) { open = true; yield { type: "text_delta", text: `${OPEN_TAG}\n` }; }
      yield { type: "text_delta", text: ev.text };
      continue;
    }
    if (ev.type === "reasoning_stop") {
      if (open) { yield close(); open = false; }
      redacted = false;
      continue;
    }
    if (open) { yield close(); open = false; }
    redacted = false;
    yield ev;
  }
  if (open) yield close();
}

/** Pure live presentation; no parsing is inferred from the output format. */
export function withThinkingFormat(
  events: AsyncGenerator<StreamEvent>,
  format: ThinkingFormat | undefined,
): AsyncGenerator<StreamEvent> {
  if (format === "none") return withoutReasoning(events);
  if (format === "think_tags") return inlineThinkTagsStream(events);
  return events;
}
