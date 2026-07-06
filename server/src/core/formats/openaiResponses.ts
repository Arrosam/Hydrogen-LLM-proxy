import {
  normalizeMessages,
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
 * OpenAI Responses API (/v1/responses) -- ingress only. Clients (Codex CLI,
 * newer OpenAI SDK apps) speak this format to the proxy; upstream calls still
 * go out as Chat Completions or Anthropic Messages. The streaming serializer
 * lives in ./stream.ts alongside the other client-SSE serializers.
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
    messages: normalizeMessages(messages),
    tools: parseTools(body.tools),
    toolChoice: parseToolChoice(body.tool_choice),
    maxTokens: numOrUndef(body.max_output_tokens),
    temperature: numOrUndef(body.temperature),
    topP: numOrUndef(body.top_p),
    stream: Boolean(body.stream),
    thinking: parseReasoning(body.reasoning),
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
