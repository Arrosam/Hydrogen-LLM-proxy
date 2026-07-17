import { Request, type RenderTarget } from "../ir/request";
import { Response } from "../ir/response";
import {
  normalizeMessages,
  stripStaleReasoning,
  type ContentPart,
  type ImagePart,
  type Message,
  type StopReason,
  type TextPart,
  type Tool,
  type ToolChoice,
} from "../ir/content";
import type { GenerationParams, ThinkingLevel } from "../ir/params";
import { DEFAULT_ANTHROPIC_MAX_TOKENS, ThinkingPolicy } from "../ir/thinking";
import { parseSSE, safeParseJson, type StreamContext, type StreamEvent } from "../ir/stream";
import { genId, nowSeconds } from "../../util/ids";
import { applyNonCanonical, collectPassthrough, num, numOrUndef } from "./wire";
import { registerFormat } from "./registry";
import type { SendTarget, Transport } from "../upstream/transport";
import type { RelayResult, SendResult } from "../upstream/outcome";
import { relayStream, sendBuffered } from "../upstream/roundtrip";

// --- stop reason mapping -------------------------------------------------

function stopReasonToStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "content_filter";
    default:
      return reason ? "stop" : null;
  }
}

function stopToAnthropic(reason: StopReason): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

// --- block <-> part coercion ---------------------------------------------

function systemToText(system: unknown): string | undefined {
  if (system == null) return undefined;
  if (typeof system === "string") return system || undefined;
  if (Array.isArray(system)) {
    const text = system
      .filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
      .map((b) => String((b as Record<string, unknown>).text ?? ""))
      .join("\n\n");
    return text || undefined;
  }
  return undefined;
}

function parseImageSource(source: unknown): ImagePart["source"] {
  const s = (source ?? {}) as Record<string, unknown>;
  if (s.type === "url") return { kind: "url", url: String(s.url ?? "") };
  return { kind: "base64", mediaType: String(s.media_type ?? "image/png"), data: String(s.data ?? "") };
}

function imageSourceToBlock(source: ImagePart["source"]): unknown {
  if (source.kind === "url") return { type: "url", url: source.url };
  return { type: "base64", media_type: source.mediaType, data: source.data };
}

function blocksToParts(content: unknown): ContentPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case "thinking":
        parts.push({ type: "reasoning", text: String(b.thinking ?? ""), signature: b.signature != null ? String(b.signature) : undefined });
        break;
      case "redacted_thinking":
        parts.push({ type: "reasoning", text: "(redacted thinking)", signature: b.data != null ? String(b.data) : undefined });
        break;
      case "text":
        parts.push({ type: "text", text: String(b.text ?? "") });
        break;
      case "image":
        parts.push({ type: "image", source: parseImageSource(b.source) });
        break;
      case "tool_use":
        parts.push({ type: "tool_use", id: String(b.id ?? genId("toolu")), name: String(b.name ?? ""), input: b.input ?? {} });
        break;
      case "tool_result":
        parts.push({
          type: "tool_result",
          toolUseId: String(b.tool_use_id ?? ""),
          content: blocksToParts(b.content).filter((p): p is TextPart | ImagePart => p.type === "text" || p.type === "image"),
          isError: b.is_error === true ? true : undefined,
        });
        break;
    }
  }
  return parts;
}

function partsToBlocks(parts: ContentPart[]): unknown[] {
  const blocks: unknown[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        blocks.push({ type: "text", text: p.text });
        break;
      case "reasoning":
        blocks.push({ type: "thinking", thinking: p.text, ...(p.signature ? { signature: p.signature } : {}) });
        break;
      case "image":
        blocks.push({ type: "image", source: imageSourceToBlock(p.source) });
        break;
      case "tool_use":
        blocks.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
        break;
      case "tool_result":
        blocks.push({ type: "tool_result", tool_use_id: p.toolUseId, content: partsToBlocks(p.content), ...(p.isError ? { is_error: true } : {}) });
        break;
    }
  }
  return blocks;
}

// --- tools ---------------------------------------------------------------

function parseTools(raw: unknown): Tool[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: Tool[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const tool = t as Record<string, unknown>;
    if (!tool.name) continue;
    tools.push({
      name: String(tool.name),
      description: tool.description ? String(tool.description) : undefined,
      parameters: (tool.input_schema as Record<string, unknown>) ?? { type: "object", properties: {} },
    });
  }
  return tools.length ? tools : undefined;
}

function parseToolChoice(raw: unknown): ToolChoice | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "required" };
    case "none":
      return { type: "none" };
    case "tool":
      return c.name ? { type: "tool", name: String(c.name) } : { type: "required" };
    default:
      return undefined;
  }
}

function toolChoiceToAnthropic(choice: ToolChoice): unknown {
  switch (choice.type) {
    case "auto":
      return { type: "auto" };
    case "none":
      return { type: "none" };
    case "required":
      return { type: "any" };
    case "tool":
      return { type: "tool", name: choice.name };
  }
}

// --- thinking / params ---------------------------------------------------

function parseThinking(body: Record<string, unknown>): ThinkingLevel | undefined {
  const t = body.thinking;
  if (!t || typeof t !== "object") return undefined;
  const cfg = t as Record<string, unknown>;
  if (cfg.type === "enabled") {
    const budget = numOrUndef(cfg.budget_tokens);
    return budget != null ? { budget } : "enabled";
  }
  if (cfg.type === "disabled") return "disabled";
  return undefined;
}

/** Every key this format models itself — parsed below, or emitted by `render`. */
const RESERVED = new Set([
  "model",
  "messages",
  "system",
  "stream",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "stop_sequences",
  "thinking",
]);

function parseParams(body: Record<string, unknown>): GenerationParams {
  const params: GenerationParams = {};
  if (numOrUndef(body.temperature) != null) params.temperature = numOrUndef(body.temperature);
  if (numOrUndef(body.top_p) != null) params.topP = numOrUndef(body.top_p);
  if (numOrUndef(body.top_k) != null) params.topK = numOrUndef(body.top_k);
  if (numOrUndef(body.max_tokens) != null) params.maxTokens = numOrUndef(body.max_tokens);
  if (Array.isArray(body.stop_sequences)) params.stop = body.stop_sequences.map(String);
  const thinking = parseThinking(body);
  if (thinking) params.thinking = thinking;
  // `metadata` (and any other unmodeled key) rides the family-scoped passthrough,
  // not `extra`: it is an Anthropic-shaped field, so it must reach only Anthropic
  // providers -- `extra` applies to every family and would leak it to OpenAI.
  const passthrough = collectPassthrough(body, RESERVED, "anthropic");
  if (passthrough) params.passthrough = passthrough;
  return params;
}

export class AnthropicRequest extends Request {
  readonly family = "anthropic" as const;

  static parse(body: Record<string, unknown>): AnthropicRequest {
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages: Message[] = [];
    for (const raw of rawMessages) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const role = m.role === "assistant" ? "assistant" : "user";
      messages.push({ role, content: blocksToParts(m.content) });
    }
    return new AnthropicRequest({
      requestedService: String(body.model ?? ""),
      system: systemToText(body.system),
      messages: stripStaleReasoning(normalizeMessages(messages)),
      tools: parseTools(body.tools),
      toolChoice: parseToolChoice(body.tool_choice),
      params: parseParams(body),
      stream: Boolean(body.stream),
    });
  }

  render(target: RenderTarget): Record<string, unknown> {
    const messages = this.messages.map((m) => ({ role: m.role, content: partsToBlocks(m.content) }));
    const p = this.params;
    const cap = target.providerMaxOutputTokens;

    const out: Record<string, unknown> = { model: target.upstreamModel, messages };
    if (this.system) out.system = this.system;
    if (this.tools) {
      out.tools = this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    if (this.toolChoice) out.tool_choice = toolChoiceToAnthropic(this.toolChoice);
    if (p.temperature != null) out.temperature = p.temperature;
    if (p.topP != null) out.top_p = p.topP;
    if (p.topK != null) out.top_k = p.topK;
    if (p.stop && p.stop.length) out.stop_sequences = p.stop;
    if (this.stream) out.stream = true;

    if (p.thinking) {
      // The thinking policy also owns max_tokens: it fits the budget under the
      // client's requested max and the provider's hard cap.
      const tf = ThinkingPolicy.anthropic(p.thinking, p.maxTokens, cap, p.thinkingImposed === true);
      out.thinking = tf.thinking;
      out.max_tokens = tf.max_tokens;
    } else {
      let maxTokens = p.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
      if (cap != null && maxTokens > cap) maxTokens = cap;
      out.max_tokens = maxTokens;
    }
    applyNonCanonical(out, p, this.family);
    return out;
  }

  /** Rebuild any canonical Request as an Anthropic Messages request. */
  static construct(base: Request): AnthropicRequest {
    return new AnthropicRequest(base.data());
  }

  send(transport: Transport, target: SendTarget): Promise<SendResult> {
    return sendBuffered(this, transport, target);
  }

  relay(transport: Transport, target: SendTarget): Promise<RelayResult> {
    return relayStream(this, transport, target);
  }
}

export class AnthropicResponse extends Response {
  readonly family = "anthropic" as const;

  static parse(body: Record<string, unknown>): AnthropicResponse {
    const content = blocksToParts(body.content).filter(
      (p) => p.type === "text" || p.type === "tool_use" || p.type === "reasoning",
    );
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    const promptTokens = numOrUndef(usage.input_tokens) ?? 0;
    const completionTokens = numOrUndef(usage.output_tokens) ?? 0;
    return new AnthropicResponse({
      id: String(body.id ?? genId("msg")),
      model: String(body.model ?? ""),
      created: nowSeconds(),
      content,
      stopReason: stopReasonToStop(body.stop_reason as string | null),
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    });
  }

  renderSelf(model: string): Record<string, unknown> {
    const content: unknown[] = [];
    for (const p of this.content) {
      if (p.type === "reasoning") content.push({ type: "thinking", thinking: p.text, ...(p.signature ? { signature: p.signature } : {}) });
      else if (p.type === "text") content.push({ type: "text", text: p.text });
      else if (p.type === "tool_use") content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    return {
      id: this.id,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stopToAnthropic(this.stopReason),
      stop_sequence: null,
      usage: { input_tokens: this.usage.promptTokens, output_tokens: this.usage.completionTokens },
    };
  }

  static async *parseStream(readable: AsyncIterable<Buffer | string>): AsyncGenerator<StreamEvent> {
    let stopReason: StopReason = null;
    let inputTokens = 0;
    let outputTokens = 0;
    const toolBlocks = new Set<number>();

    for await (const frame of parseSSE(readable)) {
      const data = safeParseJson(frame.data);
      if (!data) continue;
      const type = frame.event ?? String(data.type ?? "");

      switch (type) {
        case "message_start": {
          const message = (data.message ?? {}) as Record<string, unknown>;
          const usage = (message.usage ?? {}) as Record<string, unknown>;
          inputTokens = num(usage.input_tokens);
          yield { type: "start", id: String(message.id ?? genId("msg")), model: String(message.model ?? ""), created: nowSeconds(), inputTokens };
          break;
        }
        case "content_block_start": {
          const index = num(data.index);
          const block = (data.content_block ?? {}) as Record<string, unknown>;
          if (block.type === "tool_use") {
            toolBlocks.add(index);
            yield { type: "tool_start", index, id: String(block.id ?? genId("toolu")), name: String(block.name ?? "") };
          }
          break;
        }
        case "content_block_delta": {
          const index = num(data.index);
          const delta = (data.delta ?? {}) as Record<string, unknown>;
          if (delta.type === "text_delta" && typeof delta.text === "string") yield { type: "text_delta", text: delta.text };
          else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") yield { type: "reasoning_delta", text: delta.thinking };
          else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") yield { type: "tool_args_delta", index, delta: delta.partial_json };
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
          if (delta.stop_reason) stopReason = stopReasonToStop(delta.stop_reason as string);
          const usage = (data.usage ?? {}) as Record<string, unknown>;
          if (usage.output_tokens != null) outputTokens = num(usage.output_tokens);
          // Some providers report the real prompt count only here.
          if (num(usage.input_tokens) > 0) inputTokens = num(usage.input_tokens);
          break;
        }
        case "message_stop": {
          const stopUsage = (data.usage ?? {}) as Record<string, unknown>;
          if (num(stopUsage.output_tokens) > 0) outputTokens = num(stopUsage.output_tokens);
          if (num(stopUsage.input_tokens) > 0) inputTokens = num(stopUsage.input_tokens);
          yield { type: "finish", stopReason, usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens } };
          return;
        }
        default:
          break;
      }
    }
    // Reached only when the stream ended without a message_stop -- truncated.
    yield { type: "finish", stopReason, usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens }, incomplete: true };
  }

  static async *serializeStream(events: AsyncGenerator<StreamEvent>, ctx: StreamContext): AsyncGenerator<string> {
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
            message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } },
          });
          break;
        case "text_delta":
          if (!textOpen) {
            if (reasoningOpen) {
              yield frame("content_block_stop", { index: reasoningIndex });
              reasoningOpen = false;
            }
            textIndex = nextIndex++;
            textOpen = true;
            yield frame("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } });
          }
          yield frame("content_block_delta", { index: textIndex, delta: { type: "text_delta", text: ev.text } });
          break;
        case "reasoning_delta":
          if (!reasoningOpen) {
            reasoningIndex = nextIndex++;
            reasoningOpen = true;
            yield frame("content_block_start", { index: reasoningIndex, content_block: { type: "thinking", thinking: "" } });
          }
          yield frame("content_block_delta", { index: reasoningIndex, delta: { type: "thinking_delta", thinking: ev.text } });
          break;
        case "tool_start": {
          // Close any open thinking/text block first; overlapping content blocks
          // make a strict Anthropic client drop the unclosed one (e.g. the
          // thinking block on a text-less, tool-only response).
          if (reasoningOpen) {
            yield frame("content_block_stop", { index: reasoningIndex });
            reasoningOpen = false;
          }
          if (textOpen) {
            yield frame("content_block_stop", { index: textIndex });
            textOpen = false;
          }
          const idx = nextIndex++;
          toolMap.set(ev.index, idx);
          yield frame("content_block_start", { index: idx, content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} } });
          break;
        }
        case "tool_args_delta": {
          const idx = toolMap.get(ev.index);
          if (idx != null) yield frame("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: ev.delta } });
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
          // A truncated upstream must not be dressed up as a finished answer:
          // no message_delta, no message_stop. relay() aborts the connection.
          if (ev.incomplete) return;
          if (reasoningOpen) {
            yield frame("content_block_stop", { index: reasoningIndex });
            reasoningOpen = false;
          }
          if (textOpen) {
            yield frame("content_block_stop", { index: textIndex });
            textOpen = false;
          }
          for (const idx of toolMap.values()) yield frame("content_block_stop", { index: idx });
          toolMap.clear();
          if (ev.usage) {
            inputTokens = ev.usage.promptTokens || inputTokens;
            outputTokens = ev.usage.completionTokens || outputTokens;
          }
          yield frame("message_delta", { delta: { stop_reason: stopToAnthropic(ev.stopReason), stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
          yield frame("message_stop", {});
          break;
      }
    }
  }
}

registerFormat("anthropic", { request: AnthropicRequest, response: AnthropicResponse });

export { stopReasonToStop, stopToAnthropic };
