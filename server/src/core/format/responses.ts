import { Request, type RenderTarget } from "../ir/request";
import { Response } from "../ir/response";
import {
  normalizeMessages,
  stripStaleReasoning,
  reasoningOf,
  textOf,
  type ContentPart,
  type Message,
  type Tool,
  type ToolChoice,
} from "../ir/content";
import type { GenerationParams, ResponseFormat, ThinkingLevel } from "../ir/params";
import { ThinkingPolicy } from "../ir/thinking";
import { parseSSE, safeParseJson, type StreamContext, type StreamEvent } from "../ir/stream";
import { genId, nowSeconds } from "../../util/ids";
import { boolOrUndef, imageUrlOf, num, numOrUndef, parseDataUrl, safeJsonParse, strOrUndef } from "./wire";
import { registerFormat } from "./registry";
import type { SendTarget, Transport } from "../upstream/transport";
import type { RelayResult, SendResult } from "../upstream/outcome";
import { relayStream, sendBuffered } from "../upstream/roundtrip";

/**
 * OpenAI Responses API (/v1/responses), both directions: clients (Codex CLI,
 * newer OpenAI SDK apps) speak it to the proxy, and "openai_responses" providers
 * are called with it upstream.
 */

// --- content -------------------------------------------------------------

function contentToParts(content: unknown): ContentPart[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    switch (part.type) {
      case "input_text":
      case "output_text":
      case "text":
        parts.push({ type: "text", text: String(part.text ?? "") });
        break;
      case "input_image": {
        const img = part.image_url;
        const url = typeof img === "string" ? img : String((img as Record<string, unknown>)?.url ?? "");
        if (url) parts.push({ type: "image", source: parseDataUrl(url) });
        break;
      }
    }
  }
  return parts;
}

/** function_call_output "output": a string, or an array of text parts. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return textOf(contentToParts(output));
}

// --- tools ---------------------------------------------------------------

function parseTools(raw: unknown): Tool[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: Tool[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const tool = t as Record<string, unknown>;
    // Responses tools are flattened (no nested "function" object).
    if (tool.type !== "function" || !tool.name) continue;
    tools.push({
      name: String(tool.name),
      description: tool.description ? String(tool.description) : undefined,
      parameters: (tool.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
    });
  }
  return tools.length ? tools : undefined;
}

function parseToolChoice(raw: unknown): ToolChoice | undefined {
  if (raw == null) return undefined;
  if (raw === "auto") return { type: "auto" };
  if (raw === "none") return { type: "none" };
  if (raw === "required") return { type: "required" };
  if (typeof raw === "object") {
    const c = raw as Record<string, unknown>;
    if (c.type === "function" && c.name) return { type: "tool", name: String(c.name) };
  }
  return undefined;
}

function toolChoiceToResponses(choice: ToolChoice): unknown {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return "required";
    case "tool":
      return { type: "function", name: choice.name };
  }
}

// --- response_format (text.format) ---------------------------------------

function parseResponseFormat(text: unknown): ResponseFormat | undefined {
  if (!text || typeof text !== "object") return undefined;
  const fmt = (text as Record<string, unknown>).format;
  if (!fmt || typeof fmt !== "object") return undefined;
  const f = fmt as Record<string, unknown>;
  if (f.type === "text") return { type: "text" };
  if (f.type === "json_object") return { type: "json_object" };
  if (f.type === "json_schema") {
    return {
      type: "json_schema",
      name: f.name ? String(f.name) : undefined,
      schema: (f.schema as Record<string, unknown>) ?? {},
      strict: typeof f.strict === "boolean" ? f.strict : undefined,
    };
  }
  return undefined;
}

function responseFormatToResponses(rf: ResponseFormat): unknown {
  if (rf.type === "json_schema") {
    return { format: { type: "json_schema", name: rf.name ?? "schema", schema: rf.schema, ...(rf.strict != null ? { strict: rf.strict } : {}) } };
  }
  return { format: { type: rf.type } };
}

// --- thinking / params ---------------------------------------------------

function parseThinking(raw: unknown): ThinkingLevel | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const effort = (raw as Record<string, unknown>).effort;
  if (effort === "none" || effort === "disabled") return "disabled";
  if (
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
  ) {
    return effort;
  }
  return undefined;
}

function parseParams(body: Record<string, unknown>): GenerationParams {
  const params: GenerationParams = {};
  if (numOrUndef(body.temperature) != null) params.temperature = numOrUndef(body.temperature);
  if (numOrUndef(body.top_p) != null) params.topP = numOrUndef(body.top_p);
  if (numOrUndef(body.max_output_tokens) != null) params.maxTokens = numOrUndef(body.max_output_tokens);
  const thinking = parseThinking(body.reasoning);
  if (thinking) params.thinking = thinking;
  const rf = parseResponseFormat(body.text);
  if (rf) params.responseFormat = rf;
  if (boolOrUndef(body.parallel_tool_calls) != null) params.parallelToolCalls = boolOrUndef(body.parallel_tool_calls);
  if (strOrUndef(body.service_tier) != null) params.serviceTier = strOrUndef(body.service_tier);
  if (strOrUndef(body.user) != null) params.user = strOrUndef(body.user);
  return params;
}

// --- request subclass ----------------------------------------------------

export class OpenAIResponsesRequest extends Request {
  readonly family = "openai_responses" as const;

  static parse(body: Record<string, unknown>): OpenAIResponsesRequest {
    const systemChunks: string[] = [];
    if (typeof body.instructions === "string" && body.instructions) systemChunks.push(body.instructions);

    const messages: Message[] = [];
    const input = body.input;
    if (typeof input === "string") {
      if (input) messages.push({ role: "user", content: [{ type: "text", text: input }] });
    } else if (Array.isArray(input)) {
      for (const raw of input) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        const type = item.type ?? "message";
        if (type === "message") {
          const role = String(item.role ?? "user");
          const parts = contentToParts(item.content);
          if (role === "system" || role === "developer") {
            const text = textOf(parts);
            if (text) systemChunks.push(text);
          } else if (parts.length) {
            messages.push({ role: role === "assistant" ? "assistant" : "user", content: parts });
          }
        } else if (type === "function_call") {
          messages.push({
            role: "assistant",
            content: [{ type: "tool_use", id: String(item.call_id ?? genId("call")), name: String(item.name ?? ""), input: safeJsonParse(item.arguments) }],
          });
        } else if (type === "function_call_output") {
          messages.push({
            role: "user",
            content: [{ type: "tool_result", toolUseId: String(item.call_id ?? ""), content: [{ type: "text", text: outputText(item.output) }] }],
          });
        }
        // "reasoning" items are history bookkeeping; nothing to send upstream.
      }
    }

    return new OpenAIResponsesRequest({
      requestedService: String(body.model ?? ""),
      system: systemChunks.length ? systemChunks.join("\n\n") : undefined,
      messages: stripStaleReasoning(normalizeMessages(messages)),
      tools: parseTools(body.tools),
      toolChoice: parseToolChoice(body.tool_choice),
      params: parseParams(body),
      stream: Boolean(body.stream),
    });
  }

  render(target: RenderTarget): Record<string, unknown> {
    const input: Record<string, unknown>[] = [];
    for (const m of this.messages) {
      let parts: Record<string, unknown>[] = [];
      const flushParts = (): void => {
        if (parts.length) {
          input.push({ role: m.role, content: parts });
          parts = [];
        }
      };
      for (const p of m.content) {
        if (p.type === "text") {
          parts.push({ type: m.role === "assistant" ? "output_text" : "input_text", text: p.text });
        } else if (p.type === "image") {
          parts.push({ type: "input_image", image_url: imageUrlOf(p.source) });
        } else if (p.type === "tool_use") {
          flushParts();
          input.push({ type: "function_call", call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}) });
        } else if (p.type === "tool_result") {
          flushParts();
          input.push({ type: "function_call_output", call_id: p.toolUseId, output: textOf(p.content) });
        }
        // Reasoning parts pair with provider-side item ids; they can't be replayed.
      }
      flushParts();
    }

    const p = this.params;
    // store:false keeps the proxy stateless (no server-side response storage).
    const out: Record<string, unknown> = { model: target.upstreamModel, input, store: false };
    if (this.system) out.instructions = this.system;
    if (this.tools) {
      out.tools = this.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
    }
    if (this.toolChoice) out.tool_choice = toolChoiceToResponses(this.toolChoice);
    if (p.maxTokens != null) out.max_output_tokens = p.maxTokens;
    if (p.temperature != null) out.temperature = p.temperature;
    if (p.topP != null) out.top_p = p.topP;
    if (p.responseFormat) out.text = responseFormatToResponses(p.responseFormat);
    if (p.parallelToolCalls != null) out.parallel_tool_calls = p.parallelToolCalls;
    if (p.serviceTier != null) out.service_tier = p.serviceTier;
    if (p.user != null) out.user = p.user;
    if (this.stream) out.stream = true;
    if (p.thinking) out.reasoning = ThinkingPolicy.responses(p.thinking).reasoning;
    if (p.extra) Object.assign(out, p.extra);
    return out;
  }

  /** Rebuild any canonical Request as an OpenAI Responses request. */
  static construct(base: Request): OpenAIResponsesRequest {
    return new OpenAIResponsesRequest(base.data());
  }

  send(transport: Transport, target: SendTarget): Promise<SendResult> {
    return sendBuffered(this, transport, target);
  }

  relay(transport: Transport, target: SendTarget): Promise<RelayResult> {
    return relayStream(this, transport, target);
  }
}

// --- response subclass ---------------------------------------------------

export class OpenAIResponsesResponse extends Response {
  readonly family = "openai_responses" as const;

  static parse(body: Record<string, unknown>): OpenAIResponsesResponse {
    const content: ContentPart[] = [];
    let sawToolCall = false;
    const output = Array.isArray(body.output) ? body.output : [];
    for (const raw of output) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (item.type === "reasoning") {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        const text = summary
          .map((s) => (s && typeof s === "object" ? String((s as Record<string, unknown>).text ?? "") : ""))
          .filter(Boolean)
          .join("\n");
        if (text) content.push({ type: "reasoning", text });
      } else if (item.type === "message") {
        const text = textOf(contentToParts(item.content));
        if (text) content.push({ type: "text", text });
      } else if (item.type === "function_call") {
        sawToolCall = true;
        content.push({ type: "tool_use", id: String(item.call_id ?? item.id ?? genId("call")), name: String(item.name ?? ""), input: safeJsonParse(item.arguments) });
      }
    }

    const usage = (body.usage ?? {}) as Record<string, unknown>;
    const promptTokens = numOrUndef(usage.input_tokens) ?? 0;
    const completionTokens = numOrUndef(usage.output_tokens) ?? 0;
    const incomplete = body.status === "incomplete";
    return new OpenAIResponsesResponse({
      id: String(body.id ?? genId("resp")),
      model: String(body.model ?? ""),
      created: numOrUndef(body.created_at) ?? 0,
      content,
      stopReason: incomplete ? "length" : sawToolCall ? "tool_use" : "stop",
      usage: { promptTokens, completionTokens, totalTokens: numOrUndef(usage.total_tokens) ?? promptTokens + completionTokens },
    });
  }

  renderSelf(model: string): Record<string, unknown> {
    const output: Record<string, unknown>[] = [];

    const reasoning = reasoningOf(this.content);
    if (reasoning) output.push({ type: "reasoning", id: genId("rs"), summary: [{ type: "summary_text", text: reasoning }] });

    const text = textOf(this.content);
    if (text) {
      output.push({ type: "message", id: genId("msg"), status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
    }

    for (const p of this.content) {
      if (p.type === "tool_use") {
        output.push({ type: "function_call", id: genId("fc"), call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}), status: "completed" });
      }
    }

    if (output.length === 0) {
      output.push({ type: "message", id: genId("msg"), status: "completed", role: "assistant", content: [{ type: "output_text", text: "", annotations: [] }] });
    }

    const incomplete = this.stopReason === "length";
    return {
      id: genId("resp"),
      object: "response",
      created_at: this.created,
      status: incomplete ? "incomplete" : "completed",
      error: null,
      incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
      model,
      output,
      usage: { input_tokens: this.usage.promptTokens, output_tokens: this.usage.completionTokens, total_tokens: this.usage.totalTokens },
    };
  }

  static async *parseStream(readable: AsyncIterable<Buffer | string>): AsyncGenerator<StreamEvent> {
    let started = false;
    let sawToolCall = false;
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    const toolIndexByItem = new Map<string, number>();
    let nextToolIndex = 0;

    for await (const frame of parseSSE(readable)) {
      const data = safeParseJson(frame.data);
      if (!data) continue;
      const type = frame.event ?? String(data.type ?? "");

      switch (type) {
        case "response.created": {
          const r = (data.response ?? {}) as Record<string, unknown>;
          started = true;
          yield { type: "start", id: String(r.id ?? genId("resp")), model: String(r.model ?? ""), created: num(r.created_at) || nowSeconds() };
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
            yield { type: "tool_start", index, id: String(item.call_id ?? item.id ?? genId("call")), name: String(item.name ?? "") };
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const index = toolIndexByItem.get(String(data.item_id ?? ""));
          if (index != null && typeof data.delta === "string" && data.delta) yield { type: "tool_args_delta", index, delta: data.delta };
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
            usage = { promptTokens: num(u.input_tokens), completionTokens: num(u.output_tokens), totalTokens: num(u.total_tokens) || num(u.input_tokens) + num(u.output_tokens) };
          }
          yield { type: "finish", stopReason: type === "response.incomplete" ? "length" : sawToolCall ? "tool_use" : "stop", usage };
          return;
        }
        default:
          break;
      }
    }
    if (!started) yield { type: "start", id: genId("resp"), model: "", created: nowSeconds() };
    // Reached only when the stream ended without a terminal event -- truncated.
    yield { type: "finish", stopReason: sawToolCall ? "tool_use" : "stop", usage, incomplete: true };
  }

  static async *serializeStream(events: AsyncGenerator<StreamEvent>, ctx: StreamContext): AsyncGenerator<string> {
    const id = genId("resp");
    let created = nowSeconds();
    const model = ctx.model;
    let seq = 0;
    const frame = (event: string, data: Record<string, unknown>): string =>
      `event: ${event}\ndata: ${JSON.stringify({ type: event, sequence_number: seq++, ...data })}\n\n`;

    const response = (status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      id, object: "response", created_at: created, status, error: null, incomplete_details: null, model, output: [], ...extra,
    });

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
            yield frame("response.output_item.added", { output_index: outputIndex, item: { id: reasoningId, type: "reasoning", summary: [] } });
            yield frame("response.reasoning_summary_part.added", { item_id: reasoningId, output_index: outputIndex, summary_index: 0, part: { type: "summary_text", text: "" } });
          }
          reasoningText += ev.text;
          yield frame("response.reasoning_summary_text.delta", { item_id: reasoningId, output_index: outputIndex, summary_index: 0, delta: ev.text });
          break;
        case "text_delta":
          if (msgText == null) {
            yield* closeReasoning();
            msgId = genId("msg");
            msgText = "";
            yield frame("response.output_item.added", { output_index: outputIndex, item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] } });
            yield frame("response.content_part.added", { item_id: msgId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          }
          msgText += ev.text;
          yield frame("response.output_text.delta", { item_id: msgId, output_index: outputIndex, content_index: 0, delta: ev.text });
          break;
        case "tool_start": {
          yield* closeReasoning();
          yield* closeMessage();
          const tc = { itemId: genId("fc"), callId: ev.id, name: ev.name, args: "", index: outputIndex };
          tools.set(ev.index, tc);
          outputIndex++;
          yield frame("response.output_item.added", { output_index: tc.index, item: { id: tc.itemId, type: "function_call", status: "in_progress", call_id: tc.callId, name: tc.name, arguments: "" } });
          break;
        }
        case "tool_args_delta": {
          const tc = tools.get(ev.index);
          if (tc) {
            tc.args += ev.delta;
            yield frame("response.function_call_arguments.delta", { item_id: tc.itemId, output_index: tc.index, delta: ev.delta });
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
          for (const tc of tools.values()) {
            const item = { id: tc.itemId, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: tc.args };
            yield frame("response.function_call_arguments.done", { item_id: tc.itemId, output_index: tc.index, arguments: tc.args });
            yield frame("response.output_item.done", { output_index: tc.index, item });
            output.push(item);
          }
          tools.clear();
          const incomplete = ev.stopReason === "length";
          const usage = ev.usage
            ? { input_tokens: ev.usage.promptTokens, output_tokens: ev.usage.completionTokens, total_tokens: ev.usage.totalTokens }
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
}

registerFormat("openai_responses", { request: OpenAIResponsesRequest, response: OpenAIResponsesResponse });
