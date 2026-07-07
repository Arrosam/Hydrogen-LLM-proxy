import {
  normalizeMessages,
  stripStaleReasoning,
  reasoningOf,
  textOf,
  type IRContentPart,
  type IRMessage,
  type IRRequest,
  type IRResponse,
  type IRThinkingLevel,
  type IRTool,
  type IRToolChoice,
} from "../ir";
import { genId } from "../../util/ids";
import { numOrUndef, parseDataUrl, safeJsonParse } from "./util";
import type { ClientResponseCtx } from "./openai";

/**
 * OpenAI Responses API (/v1/responses), both directions: clients (Codex CLI,
 * newer OpenAI SDK apps) speak it to the proxy, and "openai_responses"
 * providers are called with it upstream. The streaming serializer/parser live
 * in ./stream.ts alongside the other families'.
 */

// --- request: wire -> IR ---------------------------------------------------

function contentToParts(content: unknown): IRContentPart[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: IRContentPart[] = [];
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

function parseTools(raw: unknown): IRTool[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: IRTool[] = [];
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

function parseToolChoice(raw: unknown): IRToolChoice | undefined {
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

function parseReasoning(raw: unknown): IRThinkingLevel | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const effort = (raw as Record<string, unknown>).effort;
  if (effort === "minimal") return "low";
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") {
    return effort;
  }
  return undefined;
}

export function requestToIR(body: Record<string, unknown>): IRRequest {
  const systemChunks: string[] = [];
  if (typeof body.instructions === "string" && body.instructions) systemChunks.push(body.instructions);

  const messages: IRMessage[] = [];
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
          content: [
            {
              type: "tool_use",
              id: String(item.call_id ?? genId("call")),
              name: String(item.name ?? ""),
              input: safeJsonParse(item.arguments),
            },
          ],
        });
      } else if (type === "function_call_output") {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: String(item.call_id ?? ""),
              content: [{ type: "text", text: outputText(item.output) }],
            },
          ],
        });
      }
      // "reasoning" items are history bookkeeping; nothing to send upstream.
    }
  }

  return {
    requestedModel: String(body.model ?? ""),
    system: systemChunks.length ? systemChunks.join("\n\n") : undefined,
    messages: stripStaleReasoning(normalizeMessages(messages)),
    tools: parseTools(body.tools),
    toolChoice: parseToolChoice(body.tool_choice),
    maxTokens: numOrUndef(body.max_output_tokens),
    temperature: numOrUndef(body.temperature),
    topP: numOrUndef(body.top_p),
    stream: Boolean(body.stream),
    thinking: parseReasoning(body.reasoning),
  };
}

// --- request: IR -> wire (upstream) -----------------------------------------

function imageUrlOf(source: { kind: "base64"; mediaType: string; data: string } | { kind: "url"; url: string }): string {
  return source.kind === "base64" ? `data:${source.mediaType};base64,${source.data}` : source.url;
}

function applyResponsesThinking(out: Record<string, unknown>, thinking: NonNullable<IRRequest["thinking"]>): void {
  if (thinking === "disabled") out.reasoning = { effort: "none" };
  else if (thinking === "enabled" || thinking === "auto") out.reasoning = { effort: "medium" };
  else if (typeof thinking === "object") out.reasoning = { effort: "high" };
  else out.reasoning = { effort: thinking };
}

export function irToRequest(ir: IRRequest, upstreamModel: string): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const m of ir.messages) {
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
        input.push({ type: "function_call_output", call_id: p.toolUseId, output: textOf(p.content as IRContentPart[]) });
      }
      // Reasoning parts pair with provider-side item ids; they can't be replayed.
    }
    flushParts();
  }

  // store:false keeps the proxy stateless (no server-side response storage).
  const out: Record<string, unknown> = { model: upstreamModel, input, store: false };
  if (ir.system) out.instructions = ir.system;
  if (ir.tools) {
    out.tools = ir.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
  if (ir.toolChoice) out.tool_choice = irToolChoiceToResponses(ir.toolChoice);
  if (ir.maxTokens != null) out.max_output_tokens = ir.maxTokens;
  if (ir.temperature != null) out.temperature = ir.temperature;
  if (ir.topP != null) out.top_p = ir.topP;
  if (ir.stream) out.stream = true;
  if (ir.thinking) applyResponsesThinking(out, ir.thinking);
  // ir.extra holds Chat Completions pass-through keys; they aren't valid here.
  return out;
}

function irToolChoiceToResponses(choice: NonNullable<IRRequest["toolChoice"]>): unknown {
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

// --- response: wire -> IR ----------------------------------------------------

export function responseToIR(body: Record<string, unknown>): IRResponse {
  const content: IRContentPart[] = [];
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
      content.push({
        type: "tool_use",
        id: String(item.call_id ?? item.id ?? genId("call")),
        name: String(item.name ?? ""),
        input: safeJsonParse(item.arguments),
      });
    }
  }

  const usage = (body.usage ?? {}) as Record<string, unknown>;
  const promptTokens = numOrUndef(usage.input_tokens) ?? 0;
  const completionTokens = numOrUndef(usage.output_tokens) ?? 0;
  const incomplete = body.status === "incomplete";
  return {
    id: String(body.id ?? genId("resp")),
    model: String(body.model ?? ""),
    created: numOrUndef(body.created_at) ?? 0,
    content,
    stopReason: incomplete ? "length" : sawToolCall ? "tool_use" : "stop",
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: numOrUndef(usage.total_tokens) ?? promptTokens + completionTokens,
    },
  };
}

// --- response: IR -> wire (client) -----------------------------------------

export function irToResponse(ir: IRResponse, ctx: ClientResponseCtx): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];

  const reasoning = reasoningOf(ir.content);
  if (reasoning) {
    output.push({
      type: "reasoning",
      id: genId("rs"),
      summary: [{ type: "summary_text", text: reasoning }],
    });
  }

  const text = textOf(ir.content);
  if (text) {
    output.push({
      type: "message",
      id: genId("msg"),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  for (const p of ir.content) {
    if (p.type === "tool_use") {
      output.push({
        type: "function_call",
        id: genId("fc"),
        call_id: p.id,
        name: p.name,
        arguments: JSON.stringify(p.input ?? {}),
        status: "completed",
      });
    }
  }

  if (output.length === 0) {
    output.push({
      type: "message",
      id: genId("msg"),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
  }

  const incomplete = ir.stopReason === "length";
  return {
    id: genId("resp"),
    object: "response",
    created_at: ir.created,
    status: incomplete ? "incomplete" : "completed",
    error: null,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    model: ctx.model,
    output,
    usage: {
      input_tokens: ir.usage.promptTokens,
      output_tokens: ir.usage.completionTokens,
      total_tokens: ir.usage.totalTokens,
    },
  };
}
