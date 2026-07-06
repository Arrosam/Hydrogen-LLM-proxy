import type { Family, IRContentPart, IRResponse, IRStopReason, IRUsage } from "../ir";
import { genId, nowSeconds } from "../../util/ids";
import { num, safeJsonParse } from "./util";
import { finishReasonToIR } from "./openai";
import { irToStopReason } from "./anthropic";

/**
 * Canonical streaming events. Every upstream SSE stream is parsed into this
 * sequence, then re-serialized into the client's SSE format. One `start` at the
 * beginning, one `finish` at the end.
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
  | { type: "finish"; stopReason: IRStopReason; usage?: IRUsage; incomplete?: boolean };

export interface StreamContext {
  /** Model name echoed to the client (the service name). */
  model: string;
}

// --- generic SSE frame parser -------------------------------------------

export interface SSEFrame {
  event?: string;
  data: string;
}

export async function* parseSSE(
  readable: AsyncIterable<Buffer | string>,
): AsyncGenerator<SSEFrame> {
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

function safeParse(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- upstream stream -> canonical ---------------------------------------

async function* parseOpenAIStream(
  readable: AsyncIterable<Buffer | string>,
): AsyncGenerator<StreamEvent> {
  let started = false;
  let finished = false;
  let terminated = false; // saw [DONE] or a finish_reason
  let stopReason: IRStopReason = null;
  let usage: IRUsage | undefined;
  const seenTools = new Set<number>();

  for await (const frame of parseSSE(readable)) {
    if (frame.data === "[DONE]") {
      terminated = true;
      break;
    }
    const chunk = safeParse(frame.data);
    if (!chunk) continue;

    if (!started) {
      started = true;
      yield {
        type: "start",
        id: String(chunk.id ?? genId("chatcmpl")),
        model: String(chunk.model ?? ""),
        created: typeof chunk.created === "number" ? chunk.created : nowSeconds(),
      };
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;

    if (typeof delta.content === "string" && delta.content) {
      yield { type: "text_delta", text: delta.content };
    }

    // Reasoning deltas: OpenRouter-style "reasoning", DeepSeek/GLM/Grok-style
    // "reasoning_content".
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (typeof reasoning === "string" && reasoning) {
      yield { type: "reasoning_delta", text: reasoning };
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const index = typeof call.index === "number" ? call.index : 0;
      const fn = (call.function ?? {}) as Record<string, unknown>;
      if (!seenTools.has(index) && (call.id || fn.name)) {
        seenTools.add(index);
        yield {
          type: "tool_start",
          index,
          id: String(call.id ?? genId("call")),
          name: String(fn.name ?? ""),
        };
      }
      if (typeof fn.arguments === "string" && fn.arguments) {
        yield { type: "tool_args_delta", index, delta: fn.arguments };
      }
    }

    if (choice.finish_reason) {
      stopReason = finishReasonToIR(choice.finish_reason as string);
      terminated = true;
    }
    if (chunk.usage && typeof chunk.usage === "object") {
      const u = chunk.usage as Record<string, unknown>;
      usage = {
        promptTokens: num(u.prompt_tokens),
        completionTokens: num(u.completion_tokens),
        totalTokens: num(u.total_tokens) || num(u.prompt_tokens) + num(u.completion_tokens),
      };
    }
  }

  if (!finished) {
    finished = true;
    yield { type: "finish", stopReason, usage, incomplete: started && !terminated };
  }
}

async function* parseAnthropicStream(
  readable: AsyncIterable<Buffer | string>,
): AsyncGenerator<StreamEvent> {
  let stopReason: IRStopReason = null;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolBlocks = new Set<number>();

  for await (const frame of parseSSE(readable)) {
    const data = safeParse(frame.data);
    if (!data) continue;
    const type = frame.event ?? String(data.type ?? "");

    switch (type) {
      case "message_start": {
        const message = (data.message ?? {}) as Record<string, unknown>;
        const usage = (message.usage ?? {}) as Record<string, unknown>;
        inputTokens = num(usage.input_tokens);
        yield {
          type: "start",
          id: String(message.id ?? genId("msg")),
          model: String(message.model ?? ""),
          created: nowSeconds(),
          inputTokens,
        };
        break;
      }
      case "content_block_start": {
        const index = num(data.index);
        const block = (data.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "tool_use") {
          toolBlocks.add(index);
          yield {
            type: "tool_start",
            index,
            id: String(block.id ?? genId("toolu")),
            name: String(block.name ?? ""),
          };
        }
        break;
      }
      case "content_block_delta": {
        const index = num(data.index);
        const delta = (data.delta ?? {}) as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          yield { type: "reasoning_delta", text: delta.thinking };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          yield { type: "tool_args_delta", index, delta: delta.partial_json };
        }
        break;
      }
      case "content_block_stop": {
        const index = num(data.index);
        if (toolBlocks.has(index)) {
          toolBlocks.delete(index);
          yield { type: "tool_stop", index };
        }
        break;
      }
      case "message_delta": {
        const delta = (data.delta ?? {}) as Record<string, unknown>;
        if (delta.stop_reason) stopReason = anthStopToIR(delta.stop_reason as string);
        const usage = (data.usage ?? {}) as Record<string, unknown>;
        if (usage.output_tokens != null) outputTokens = num(usage.output_tokens);
        // Some providers (e.g. GLM / 閺呴缚姘?Anthropic-compatible endpoints) send
        // input_tokens: 0 in message_start and only report the real prompt count
        // in the final message_delta usage. Prefer any non-zero value we see here.
        if (num(usage.input_tokens) > 0) inputTokens = num(usage.input_tokens);
        break;
      }
      case "message_stop": {
        // Some providers report the final usage on message_stop rather than
        // message_delta; prefer any non-zero counts seen here.
        const stopUsage = (data.usage ?? {}) as Record<string, unknown>;
        if (num(stopUsage.output_tokens) > 0) outputTokens = num(stopUsage.output_tokens);
        if (num(stopUsage.input_tokens) > 0) inputTokens = num(stopUsage.input_tokens);
        yield {
          type: "finish",
          stopReason,
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens,
          },
        };
        return;
      }
      default:
        break;
    }
  }
  // Reached only when the stream ended without a message_stop -- truncated.
  yield {
    type: "finish",
    stopReason,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    incomplete: true,
  };
}

function anthStopToIR(reason: string): IRStopReason {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

/** Parse an upstream OpenAI Responses API SSE stream (response.* events). */
async function* parseResponsesStream(
  readable: AsyncIterable<Buffer | string>,
): AsyncGenerator<StreamEvent> {
  let started = false;
  let sawToolCall = false;
  let usage: IRUsage | undefined;
  const toolIndexByItem = new Map<string, number>();
  let nextToolIndex = 0;

  for await (const frame of parseSSE(readable)) {
    const data = safeParse(frame.data);
    if (!data) continue;
    const type = frame.event ?? String(data.type ?? "");

    switch (type) {
      case "response.created": {
        const r = (data.response ?? {}) as Record<string, unknown>;
        started = true;
        yield {
          type: "start",
          id: String(r.id ?? genId("resp")),
          model: String(r.model ?? ""),
          created: num(r.created_at) || nowSeconds(),
        };
        break;
      }
      case "response.output_text.delta":
        if (typeof data.delta === "string" && data.delta) yield { type: "text_delta", text: data.delta };
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (typeof data.delta === "string" && data.delta) yield { type: "reasoning_delta", text: data.delta };
        break;
      case "response.output_item.added": {
        const item = (data.item ?? {}) as Record<string, unknown>;
        if (item.type === "function_call") {
          sawToolCall = true;
          const index = nextToolIndex++;
          toolIndexByItem.set(String(item.id ?? index), index);
          yield {
            type: "tool_start",
            index,
            id: String(item.call_id ?? item.id ?? genId("call")),
            name: String(item.name ?? ""),
          };
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const index = toolIndexByItem.get(String(data.item_id ?? ""));
        if (index != null && typeof data.delta === "string" && data.delta) {
          yield { type: "tool_args_delta", index, delta: data.delta };
        }
        break;
      }
      case "response.output_item.done": {
        const item = (data.item ?? {}) as Record<string, unknown>;
        if (item.type === "function_call") {
          const index = toolIndexByItem.get(String(item.id ?? ""));
          if (index != null) yield { type: "tool_stop", index };
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const r = (data.response ?? {}) as Record<string, unknown>;
        const u = (r.usage ?? {}) as Record<string, unknown>;
        if (u.input_tokens != null || u.output_tokens != null) {
          usage = {
            promptTokens: num(u.input_tokens),
            completionTokens: num(u.output_tokens),
            totalTokens: num(u.total_tokens) || num(u.input_tokens) + num(u.output_tokens),
          };
        }
        yield {
          type: "finish",
          stopReason: type === "response.incomplete" ? "length" : sawToolCall ? "tool_use" : "stop",
          usage,
        };
        return;
      }
      default:
        break;
    }
  }
  if (!started) yield { type: "start", id: genId("resp"), model: "", created: nowSeconds() };
  // Reached only when the stream ended without response.completed/failed -- truncated.
  yield { type: "finish", stopReason: sawToolCall ? "tool_use" : "stop", usage, incomplete: true };
}

export function parseUpstreamStream(
  family: Family,
  readable: AsyncIterable<Buffer | string>,
): AsyncGenerator<StreamEvent> {
  if (family === "anthropic") return parseAnthropicStream(readable);
  if (family === "openai_responses") return parseResponsesStream(readable);
  return parseOpenAIStream(readable);
}

// --- usage/text tap (for logging) ---------------------------------------

export interface StreamAccumulator {
  usage?: IRUsage;
  stopReason: IRStopReason;
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

/**
 * Drain a canonical event stream into a complete IRResponse. Used to run an
 * upstream call as a stream but consume it inside the proxy (Micro Agent
 * stages buffer their outputs for routing; streaming upstream still captures
 * reasoning from providers that only emit it on streams, and avoids idle
 * non-streaming timeouts during long thinking).
 */
export async function collectStream(
  events: AsyncGenerator<StreamEvent>,
): Promise<{ ir: IRResponse; incomplete: boolean }> {
  let id = genId("msg");
  let model = "";
  let created = nowSeconds();
  let text = "";
  let reasoning = "";
  let stopReason: IRStopReason = null;
  let usage: IRUsage | undefined;
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

  const content: IRContentPart[] = [];
  if (reasoning) content.push({ type: "reasoning", text: reasoning });
  if (text) content.push({ type: "text", text });
  for (const index of toolOrder) {
    const tc = toolByIndex.get(index)!;
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeJsonParse(tc.args || "{}") });
  }

  return {
    ir: {
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

// --- canonical -> client SSE --------------------------------------------

function irToOpenAIFinish(reason: IRStopReason): string {
  switch (reason) {
    case "length":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

async function* serializeOpenAIStream(
  events: AsyncGenerator<StreamEvent>,
  ctx: StreamContext,
): AsyncGenerator<string> {
  let id = genId("chatcmpl");
  let created = nowSeconds();
  const model = ctx.model;

  const chunk = (payload: Record<string, unknown>): string =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, ...payload })}\n\n`;

  for await (const ev of events) {
    switch (ev.type) {
      case "start":
        id = ev.id || id;
        created = ev.created || created;
        yield chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        break;
      case "text_delta":
        yield chunk({ choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }] });
        break;
      case "reasoning_delta":
        yield chunk({ choices: [{ index: 0, delta: { reasoning: ev.text }, finish_reason: null }] });
        break;
      case "tool_start":
        yield chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: ev.index, id: ev.id, type: "function", function: { name: ev.name, arguments: "" } },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        break;
      case "tool_args_delta":
        yield chunk({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: ev.index, function: { arguments: ev.delta } }] },
              finish_reason: null,
            },
          ],
        });
        break;
      case "tool_stop":
        break;
      case "finish":
        yield chunk({ choices: [{ index: 0, delta: {}, finish_reason: irToOpenAIFinish(ev.stopReason) }] });
        if (ev.usage) {
          yield chunk({
            choices: [],
            usage: {
              prompt_tokens: ev.usage.promptTokens,
              completion_tokens: ev.usage.completionTokens,
              total_tokens: ev.usage.totalTokens,
            },
          });
        }
        yield "data: [DONE]\n\n";
        break;
    }
  }
}

async function* serializeAnthropicStream(
  events: AsyncGenerator<StreamEvent>,
  ctx: StreamContext,
): AsyncGenerator<string> {
  let id = genId("msg");
  const model = ctx.model;
  let inputTokens = 0;
  let outputTokens = 0;
  let nextIndex = 0;
  let textOpen = false;
  let textIndex = 0;
  let reasoningOpen = false;
  let reasoningIndex = 0;
  const toolMap = new Map<number, number>();

  const frame = (event: string, data: Record<string, unknown>): string =>
    `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

  for await (const ev of events) {
    switch (ev.type) {
      case "start":
        id = ev.id || id;
        inputTokens = ev.inputTokens ?? 0;
        yield frame("message_start", {
          message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        });
        break;
      case "text_delta":
        if (!textOpen) {
          textIndex = nextIndex++;
          textOpen = true;
          yield frame("content_block_start", {
            index: textIndex,
            content_block: { type: "text", text: "" },
          });
        }
        yield frame("content_block_delta", {
          index: textIndex,
          delta: { type: "text_delta", text: ev.text },
        });
        break;
      case "reasoning_delta":
        if (!reasoningOpen) {
          reasoningIndex = nextIndex++;
          reasoningOpen = true;
          yield frame("content_block_start", {
            index: reasoningIndex,
            content_block: { type: "thinking", thinking: "" },
          });
        }
        yield frame("content_block_delta", {
          index: reasoningIndex,
          delta: { type: "thinking_delta", thinking: ev.text },
        });
        break;
      case "tool_start": {
        if (textOpen) {
          yield frame("content_block_stop", { index: textIndex });
          textOpen = false;
        }
        const idx = nextIndex++;
        toolMap.set(ev.index, idx);
        yield frame("content_block_start", {
          index: idx,
          content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} },
        });
        break;
      }
      case "tool_args_delta": {
        const idx = toolMap.get(ev.index);
        if (idx != null) {
          yield frame("content_block_delta", {
            index: idx,
            delta: { type: "input_json_delta", partial_json: ev.delta },
          });
        }
        break;
      }
      case "tool_stop": {
        const idx = toolMap.get(ev.index);
        if (idx != null) {
          yield frame("content_block_stop", { index: idx });
          toolMap.delete(ev.index);
        }
        break;
      }
      case "finish":
        if (reasoningOpen) {
          yield frame("content_block_stop", { index: reasoningIndex });
          reasoningOpen = false;
        }
        if (textOpen) {
          yield frame("content_block_stop", { index: textIndex });
          textOpen = false;
        }
        for (const idx of toolMap.values()) {
          yield frame("content_block_stop", { index: idx });
        }
        toolMap.clear();
        if (ev.usage) {
          inputTokens = ev.usage.promptTokens || inputTokens;
          outputTokens = ev.usage.completionTokens || outputTokens;
        }
        yield frame("message_delta", {
          delta: { stop_reason: irToStopReason(ev.stopReason), stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
        yield frame("message_stop", {});
        break;
    }
  }
}

/** Serialize canonical events as OpenAI Responses API SSE (response.* events). */
async function* serializeResponsesStream(
  events: AsyncGenerator<StreamEvent>,
  ctx: StreamContext,
): AsyncGenerator<string> {
  const id = genId("resp");
  let created = nowSeconds();
  const model = ctx.model;
  let seq = 0;
  const frame = (event: string, data: Record<string, unknown>): string =>
    `event: ${event}\ndata: ${JSON.stringify({ type: event, sequence_number: seq++, ...data })}\n\n`;

  const response = (status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, object: "response", created_at: created, status, error: null, incomplete_details: null,
    model, output: [], ...extra,
  });

  // Completed output items, accumulated for the final response.completed frame.
  const output: Record<string, unknown>[] = [];
  let outputIndex = 0;

  let msgId = "";
  let msgText: string | null = null; // null = no message item open
  let reasoningId = "";
  let reasoningText: string | null = null;
  const tools = new Map<number, { itemId: string; callId: string; name: string; args: string; index: number }>();

  function* closeReasoning(): Generator<string> {
    if (reasoningText == null) return;
    const item = { id: reasoningId, type: "reasoning", summary: [{ type: "summary_text", text: reasoningText }] };
    yield frame("response.reasoning_summary_text.done", { item_id: reasoningId, output_index: outputIndex, summary_index: 0, text: reasoningText });
    yield frame("response.reasoning_summary_part.done", { item_id: reasoningId, output_index: outputIndex, summary_index: 0, part: { type: "summary_text", text: reasoningText } });
    yield frame("response.output_item.done", { output_index: outputIndex, item });
    output.push(item);
    outputIndex++;
    reasoningText = null;
  }

  function* closeMessage(): Generator<string> {
    if (msgText == null) return;
    const part = { type: "output_text", text: msgText, annotations: [] };
    const item = { id: msgId, type: "message", status: "completed", role: "assistant", content: [part] };
    yield frame("response.output_text.done", { item_id: msgId, output_index: outputIndex, content_index: 0, text: msgText });
    yield frame("response.content_part.done", { item_id: msgId, output_index: outputIndex, content_index: 0, part });
    yield frame("response.output_item.done", { output_index: outputIndex, item });
    output.push(item);
    outputIndex++;
    msgText = null;
  }

  for await (const ev of events) {
    switch (ev.type) {
      case "start":
        created = ev.created || created;
        yield frame("response.created", { response: response("in_progress") });
        yield frame("response.in_progress", { response: response("in_progress") });
        break;
      case "reasoning_delta":
        if (reasoningText == null) {
          yield* closeMessage();
          reasoningId = genId("rs");
          reasoningText = "";
          yield frame("response.output_item.added", {
            output_index: outputIndex,
            item: { id: reasoningId, type: "reasoning", summary: [] },
          });
          yield frame("response.reasoning_summary_part.added", {
            item_id: reasoningId, output_index: outputIndex, summary_index: 0,
            part: { type: "summary_text", text: "" },
          });
        }
        reasoningText += ev.text;
        yield frame("response.reasoning_summary_text.delta", {
          item_id: reasoningId, output_index: outputIndex, summary_index: 0, delta: ev.text,
        });
        break;
      case "text_delta":
        if (msgText == null) {
          yield* closeReasoning();
          msgId = genId("msg");
          msgText = "";
          yield frame("response.output_item.added", {
            output_index: outputIndex,
            item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] },
          });
          yield frame("response.content_part.added", {
            item_id: msgId, output_index: outputIndex, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        msgText += ev.text;
        yield frame("response.output_text.delta", {
          item_id: msgId, output_index: outputIndex, content_index: 0, delta: ev.text,
        });
        break;
      case "tool_start": {
        yield* closeReasoning();
        yield* closeMessage();
        const tc = { itemId: genId("fc"), callId: ev.id, name: ev.name, args: "", index: outputIndex };
        tools.set(ev.index, tc);
        outputIndex++;
        yield frame("response.output_item.added", {
          output_index: tc.index,
          item: { id: tc.itemId, type: "function_call", status: "in_progress", call_id: tc.callId, name: tc.name, arguments: "" },
        });
        break;
      }
      case "tool_args_delta": {
        const tc = tools.get(ev.index);
        if (tc) {
          tc.args += ev.delta;
          yield frame("response.function_call_arguments.delta", {
            item_id: tc.itemId, output_index: tc.index, delta: ev.delta,
          });
        }
        break;
      }
      case "tool_stop": {
        const tc = tools.get(ev.index);
        if (tc) {
          tools.delete(ev.index);
          const item = { id: tc.itemId, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: tc.args };
          yield frame("response.function_call_arguments.done", { item_id: tc.itemId, output_index: tc.index, arguments: tc.args });
          yield frame("response.output_item.done", { output_index: tc.index, item });
          output.push(item);
        }
        break;
      }
      case "finish": {
        yield* closeReasoning();
        yield* closeMessage();
        // OpenAI upstreams emit no per-tool stop; close any open calls here.
        for (const tc of tools.values()) {
          const item = { id: tc.itemId, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: tc.args };
          yield frame("response.function_call_arguments.done", { item_id: tc.itemId, output_index: tc.index, arguments: tc.args });
          yield frame("response.output_item.done", { output_index: tc.index, item });
          output.push(item);
        }
        tools.clear();
        const incomplete = ev.stopReason === "length";
        const usage = ev.usage
          ? {
              input_tokens: ev.usage.promptTokens,
              output_tokens: ev.usage.completionTokens,
              total_tokens: ev.usage.totalTokens,
            }
          : undefined;
        yield frame(incomplete ? "response.incomplete" : "response.completed", {
          response: response(incomplete ? "incomplete" : "completed", {
            output,
            ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
            ...(usage ? { usage } : {}),
          }),
        });
        break;
      }
    }
  }
}

export function serializeClientStream(
  family: Family,
  events: AsyncGenerator<StreamEvent>,
  ctx: StreamContext,
): AsyncGenerator<string> {
  if (family === "anthropic") return serializeAnthropicStream(events, ctx);
  if (family === "openai_responses") return serializeResponsesStream(events, ctx);
  return serializeOpenAIStream(events, ctx);
}

/** Cap for the fabricated stream below. Fast (most models do 20閳?00 tok/s), but
 * paced so a buffered chain response still arrives as smooth progressive output
 * instead of one lump. */
const FAKE_STREAM_TOKENS_PER_SEC = 5000;
const FAKE_STREAM_CHUNK_CHARS = 24; // chars per delta (~6 tokens); smoothness, not rate

/**
 * Synthesize a client SSE stream from an already-complete IRResponse. Chains
 * buffer their stages (to evaluate routing conditions) then emit the final
 * result as a stream so streaming clients still get SSE. The text is split into
 * small deltas and paced to ~FAKE_STREAM_TOKENS_PER_SEC so the client sees it
 * stream in quickly rather than as a single chunk.
 */
export function streamFromIRResponse(
  family: Family,
  ir: IRResponse,
  ctx: StreamContext,
): AsyncGenerator<string> {
  async function* events(): AsyncGenerator<StreamEvent> {
    yield { type: "start", id: ir.id, model: ir.model, created: ir.created, inputTokens: ir.usage.promptTokens };

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
    for (const p of ir.content) {
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
    yield { type: "finish", stopReason: ir.stopReason, usage: ir.usage };
  }
  return serializeClientStream(family, events(), ctx);
}
