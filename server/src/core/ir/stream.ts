import type { ContentPart, StopReason } from "./content";
import type { Usage } from "./usage";
import { genId, nowSeconds } from "../../util/ids";
import { num, safeJsonParse } from "../format/wire";

/**
 * Canonical streaming events. Every upstream SSE stream is parsed into this
 * sequence (by the egress format subclass), then re-serialized into the client's
 * SSE format (by the ingress format subclass). One `start` at the beginning, one
 * `finish` at the end. This module owns the format-agnostic middle: the SSE
 * frame parser, the reasoning filter, the logging tap, the buffered collector,
 * and the fabricator that turns a complete response back into a paced stream.
 */
export type StreamEvent =
  | { type: "start"; id: string; model: string; created: number; inputTokens?: number }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_args_delta"; index: number; delta: string }
  | { type: "tool_stop"; index: number }
  /** `incomplete` = the upstream stream ended without a proper terminal event
   * (message_stop / [DONE] / response.completed), i.e. it was truncated. */
  | { type: "finish"; stopReason: StopReason; usage?: Usage; incomplete?: boolean };

export interface StreamContext {
  /** Model name echoed to the client (the service name). */
  model: string;
}

// --- generic SSE frame parser -------------------------------------------

export interface SSEFrame {
  event?: string;
  data: string;
}

export async function* parseSSE(readable: AsyncIterable<Buffer | string>): AsyncGenerator<SSEFrame> {
  const sep = /\r?\n\r?\n/;
  let buffer = "";
  for await (const chunk of readable) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let m: RegExpExecArray | null;
    while ((m = sep.exec(buffer))) {
      const raw = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      if (raw.trim()) yield parseFrame(raw);
    }
  }
  if (buffer.trim()) yield parseFrame(buffer);
}

function parseFrame(raw: string): SSEFrame {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: data.join("\n") };
}

export function safeParseJson(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- reasoning filter ---------------------------------------------------

/** Drop reasoning_delta events from a canonical stream. Enforces a "disabled"
 * thinking level on a live relay even when the upstream emits reasoning anyway. */
export async function* withoutReasoning(events: AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
  for await (const ev of events) {
    if (ev.type !== "reasoning_delta") yield ev;
  }
}

// --- usage/text tap (for logging) ---------------------------------------

export interface StreamAccumulator {
  usage?: Usage;
  stopReason: StopReason;
  /** Reconstructed assistant text (concatenated deltas), for logging. */
  text: string;
  /** Reconstructed reasoning/thinking text (concatenated deltas), for logging. */
  reasoning: string;
  /** Tool calls seen: name + accumulated JSON argument string. */
  toolCalls: Array<{ name: string; args: string }>;
  upstreamModel: string;
  /** True when the upstream stream ended without a proper terminal event. */
  incomplete: boolean;
}

export function newAccumulator(): StreamAccumulator {
  return { stopReason: null, text: "", reasoning: "", toolCalls: [], upstreamModel: "", incomplete: false };
}

export async function* tapStream(
  events: AsyncGenerator<StreamEvent>,
  acc: StreamAccumulator,
): AsyncGenerator<StreamEvent> {
  const toolByIndex = new Map<number, { name: string; args: string }>();
  for await (const ev of events) {
    switch (ev.type) {
      case "start":
        acc.upstreamModel = ev.model;
        break;
      case "text_delta":
        acc.text += ev.text;
        break;
      case "reasoning_delta":
        acc.reasoning += ev.text;
        break;
      case "tool_start": {
        const tc = { name: ev.name, args: "" };
        toolByIndex.set(ev.index, tc);
        acc.toolCalls.push(tc);
        break;
      }
      case "tool_args_delta": {
        const tc = toolByIndex.get(ev.index);
        if (tc) tc.args += ev.delta;
        break;
      }
      case "finish":
        acc.usage = ev.usage;
        acc.stopReason = ev.stopReason;
        acc.incomplete = ev.incomplete === true;
        break;
    }
    yield ev;
  }
}

// --- buffered collection ------------------------------------------------

/** The canonical fields a response carries; shared by Response and the stream collector. */
export interface ResponseData {
  id: string;
  model: string;
  created: number;
  content: ContentPart[];
  stopReason: StopReason;
  usage: Usage;
}

/**
 * Drain a canonical event stream into complete response data. Used to run an
 * upstream call as a stream but consume it inside the proxy: Micro Agent stages
 * buffer their outputs for routing; streaming the upstream still captures
 * reasoning from providers that only emit it on streams, and avoids idle
 * non-streaming timeouts during long thinking.
 */
export async function collectStream(
  events: AsyncGenerator<StreamEvent>,
): Promise<{ data: ResponseData; incomplete: boolean }> {
  let id = genId("msg");
  let model = "";
  let created = nowSeconds();
  let text = "";
  let reasoning = "";
  let stopReason: StopReason = null;
  let usage: Usage | undefined;
  let incomplete = false;
  const toolByIndex = new Map<number, { id: string; name: string; args: string }>();
  const toolOrder: number[] = [];

  for await (const ev of events) {
    switch (ev.type) {
      case "start":
        id = ev.id || id;
        model = ev.model || model;
        created = ev.created || created;
        break;
      case "text_delta":
        text += ev.text;
        break;
      case "reasoning_delta":
        reasoning += ev.text;
        break;
      case "tool_start":
        toolByIndex.set(ev.index, { id: ev.id, name: ev.name, args: "" });
        toolOrder.push(ev.index);
        break;
      case "tool_args_delta": {
        const tc = toolByIndex.get(ev.index);
        if (tc) tc.args += ev.delta;
        break;
      }
      case "finish":
        stopReason = ev.stopReason;
        usage = ev.usage;
        incomplete = ev.incomplete === true;
        break;
    }
  }

  const content: ContentPart[] = [];
  if (reasoning) content.push({ type: "reasoning", text: reasoning });
  if (text) content.push({ type: "text", text });
  for (const index of toolOrder) {
    const tc = toolByIndex.get(index)!;
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeJsonParse(tc.args || "{}") });
  }

  return {
    data: {
      id,
      model,
      created,
      content,
      stopReason,
      usage: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    },
    incomplete,
  };
}

// --- fabrication (complete response -> paced stream) --------------------

/** Cap for the fabricated stream. Fast (most models do 20-100 tok/s), but paced
 * so a buffered chain response still arrives as smooth progressive output
 * instead of one lump. */
const FAKE_STREAM_TOKENS_PER_SEC = 5000;
const FAKE_STREAM_CHUNK_CHARS = 24; // chars per delta (~6 tokens); smoothness, not rate

/**
 * Synthesize a canonical event stream from an already-complete response. Chains
 * buffer their stages (to evaluate routing conditions) then emit the final
 * result as a stream so streaming clients still get SSE. The text is split into
 * small deltas and paced so the client sees it stream in quickly rather than as
 * a single chunk. The caller serializes these events into the client's format.
 */
export async function* fabricateStream(data: ResponseData): AsyncGenerator<StreamEvent> {
  yield { type: "start", id: data.id, model: data.model, created: data.created, inputTokens: data.usage.promptTokens };

  const startedAt = Date.now();
  let emittedTokens = 0;
  // ~4 chars/token. Self-correcting against setTimeout jitter so the average
  // rate holds at the cap.
  const pace = async (chars: number): Promise<void> => {
    emittedTokens += Math.max(1, Math.round(chars / 4));
    const wait = (emittedTokens * 1000) / FAKE_STREAM_TOKENS_PER_SEC - (Date.now() - startedAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };

  let toolIndex = 0;
  for (const p of data.content) {
    if (p.type === "text") {
      for (let i = 0; i < p.text.length; i += FAKE_STREAM_CHUNK_CHARS) {
        const piece = p.text.slice(i, i + FAKE_STREAM_CHUNK_CHARS);
        yield { type: "text_delta", text: piece };
        await pace(piece.length);
      }
    } else if (p.type === "reasoning") {
      for (let i = 0; i < p.text.length; i += FAKE_STREAM_CHUNK_CHARS) {
        const piece = p.text.slice(i, i + FAKE_STREAM_CHUNK_CHARS);
        yield { type: "reasoning_delta", text: piece };
        await pace(piece.length);
      }
    } else if (p.type === "tool_use") {
      yield { type: "tool_start", index: toolIndex, id: p.id, name: p.name };
      yield { type: "tool_args_delta", index: toolIndex, delta: JSON.stringify(p.input ?? {}) };
      yield { type: "tool_stop", index: toolIndex };
      toolIndex++;
    }
  }
  yield { type: "finish", stopReason: data.stopReason, usage: data.usage };
}

export { num };
