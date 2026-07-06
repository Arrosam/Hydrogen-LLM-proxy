import {
  type IRContentPart,
  type IRMessage,
  type IRRequest,
  type IRResponse,
  type IRStopReason,
  type IRTextPart,
  type IRThinkingLevel,
  type IRToolChoice,
  type IRTool,
  normalizeMessages,
  textOf,
} from "../ir";
import { genId, nowSeconds } from "../../util/ids";
import { numOrUndef, pickExtra, safeJsonParse } from "./util";

export interface ClientResponseCtx {
  /** Model name echoed back to the client (the service name). */
  model: string;
}

// --- stop reason mapping -------------------------------------------------

function finishReasonToIR(reason: string | null | undefined): IRStopReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "content_filter";
    default:
      return reason ? "stop" : null;
  }
}

function irToFinishReason(reason: IRStopReason): string {
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

// --- content coercion ----------------------------------------------------

function coerceContentToParts(content: unknown): Array<IRTextPart | IRContentPart> {
  if (content == null) return [];
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: IRContentPart[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const t = (item as Record<string, unknown>).type;
    if (t === "text" || t === "input_text" || t === "output_text") {
      parts.push({ type: "text", text: String((item as Record<string, unknown>).text ?? "") });
    } else if (t === "image_url") {
      const img = (item as Record<string, unknown>).image_url as Record<string, unknown> | string;
      const url = typeof img === "string" ? img : String(img?.url ?? "");
      const parsed = parseDataUrl(url);
      parts.push({ type: "image", source: parsed });
    }
  }
  return parts;
}

function parseDataUrl(
  url: string,
): { kind: "base64"; mediaType: string; data: string } | { kind: "url"; url: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (m) return { kind: "base64", mediaType: m[1], data: m[2] };
  return { kind: "url", url };
}

function imagePartToOpenAI(source: (IRContentPart & { type: "image" })["source"]): unknown {
  const url =
    source.kind === "base64" ? `data:${source.mediaType};base64,${source.data}` : source.url;
  return { type: "image_url", image_url: { url } };
}

// --- request: wire -> IR -------------------------------------------------

export function requestToIR(body: Record<string, unknown>): IRRequest {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const systemChunks: string[] = [];
  const messages: IRMessage[] = [];

  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    const role = String(msg.role);

    if (role === "system" || role === "developer") {
      const text = typeof msg.content === "string" ? msg.content : textOf(coerceContentToParts(msg.content) as IRContentPart[]);
      if (text) systemChunks.push(text);
      continue;
    }

    if (role === "tool") {
      const resultText =
        typeof msg.content === "string"
          ? msg.content
          : textOf(coerceContentToParts(msg.content) as IRContentPart[]);
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: String(msg.tool_call_id ?? ""),
            content: [{ type: "text", text: resultText }],
          },
        ],
      });
      continue;
    }

    if (role === "assistant") {
      const content: IRContentPart[] = coerceContentToParts(msg.content) as IRContentPart[];
      // OpenAI reasoning models return reasoning in a top-level "reasoning" or "reasoning_content" field.
      const reasoning = String(msg.reasoning ?? msg.reasoning_content ?? "");
      if (reasoning) content.push({ type: "reasoning", text: reasoning });
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const call = tc as Record<string, unknown>;
        const fn = (call.function ?? {}) as Record<string, unknown>;
        content.push({
          type: "tool_use",
          id: String(call.id ?? genId("call")),
          name: String(fn.name ?? ""),
          input: safeJsonParse(fn.arguments),
        });
      }
      messages.push({ role: "assistant", content });
      continue;
    }

    // default: user
    messages.push({ role: "user", content: coerceContentToParts(msg.content) as IRContentPart[] });
  }

  const thinking = parseOpenAIThinking(body);

  return {
    requestedModel: String(body.model ?? ""),
    system: systemChunks.length ? systemChunks.join("\n\n") : undefined,
    messages: normalizeMessages(messages),
    tools: parseTools(body.tools),
    toolChoice: parseToolChoice(body.tool_choice),
    maxTokens: numOrUndef(body.max_completion_tokens) ?? numOrUndef(body.max_tokens),
    temperature: numOrUndef(body.temperature),
    topP: numOrUndef(body.top_p),
    stop: parseStop(body.stop),
    stream: Boolean(body.stream),
    thinking,
    extra: pickExtra(body, [
      "frequency_penalty",
      "presence_penalty",
      "seed",
      "response_format",
      "logit_bias",
      "n",
      "user",
      "parallel_tool_calls",
    ]),
  };
}

/** Parse the thinking/reasoning configuration from an OpenAI-style request body. */
function parseOpenAIThinking(body: Record<string, unknown>): IRThinkingLevel | undefined {
  // OpenAI reasoning models use "reasoning_effort": "minimal"|"low"|...|"max".
  const effort = body.reasoning_effort;
  if (effort === "none" || effort === "disabled") return "disabled";
  if (effort === "minimal") return "low";
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") {
    return effort;
  }
  if (typeof body.max_completion_tokens === "number" && body.reasoning_effort != null) {
    return { budget: body.max_completion_tokens as number };
  }
  return undefined;
}

function parseTools(raw: unknown): IRTool[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: IRTool[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const fn = ((t as Record<string, unknown>).function ?? {}) as Record<string, unknown>;
    if (!fn.name) continue;
    tools.push({
      name: String(fn.name),
      description: fn.description ? String(fn.description) : undefined,
      parameters: (fn.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
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
    const fn = ((raw as Record<string, unknown>).function ?? {}) as Record<string, unknown>;
    if (fn.name) return { type: "tool", name: String(fn.name) };
  }
  return undefined;
}

// --- request: IR -> wire (upstream) --------------------------------------

export function irToRequest(ir: IRRequest, upstreamModel: string): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (ir.system) messages.push({ role: "system", content: ir.system });

  for (const m of ir.messages) {
    if (m.role === "assistant") {
      const textParts = m.content.filter((p): p is IRTextPart => p.type === "text");
      const reasoningParts = m.content.filter((p) => p.type === "reasoning");
      const toolUses = m.content.filter((p) => p.type === "tool_use");
      const entry: Record<string, unknown> = { role: "assistant" };
      entry.content = textParts.length ? textParts.map((p) => p.text).join("") : null;
      if (reasoningParts.length) {
        entry.reasoning = reasoningParts.map((p) => (p as { text: string }).text).join("");
      }
      if (toolUses.length) {
        entry.tool_calls = toolUses.map((tu) => ({
          id: (tu as { id: string }).id,
          type: "function",
          function: {
            name: (tu as { name: string }).name,
            arguments: JSON.stringify((tu as { input: unknown }).input ?? {}),
          },
        }));
      }
      messages.push(entry);
      continue;
    }

    // user role: split out tool_result parts into separate tool messages.
    const toolResults = m.content.filter((p) => p.type === "tool_result");
    const others = m.content.filter((p) => p.type !== "tool_result");
    for (const tr of toolResults) {
      const r = tr as Extract<IRContentPart, { type: "tool_result" }>;
      messages.push({
        role: "tool",
        tool_call_id: r.toolUseId,
        content: textOf(r.content as IRContentPart[]),
      });
    }
    if (others.length) {
      messages.push({ role: "user", content: openAiUserContent(others) });
    }
  }

  const out: Record<string, unknown> = { model: upstreamModel, messages };
  if (ir.tools) {
    out.tools = ir.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (ir.toolChoice) out.tool_choice = irToolChoiceToOpenAI(ir.toolChoice);
  if (ir.maxTokens != null) out.max_tokens = ir.maxTokens;
  if (ir.temperature != null) out.temperature = ir.temperature;
  if (ir.topP != null) out.top_p = ir.topP;
  if (ir.stop && ir.stop.length) out.stop = ir.stop;
  if (ir.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  // Apply thinking/reasoning level to the upstream request.
  if (ir.thinking) applyOpenAIThinking(out, ir.thinking);
  if (ir.extra) Object.assign(out, ir.extra);
  return out;
}

/** Translate an IRThinkingLevel into the OpenAI reasoning_effort field. */
function applyOpenAIThinking(out: Record<string, unknown>, thinking: IRThinkingLevel): void {
  if (thinking === "disabled") {
    out.reasoning_effort = "none";
  } else if (thinking === "enabled" || thinking === "auto") {
    out.reasoning_effort = "medium";
  } else if (typeof thinking === "object") {
    out.reasoning_effort = "high";
    if (out.max_tokens == null) out.max_tokens = thinking.budget;
  } else {
    // A named effort level passes through verbatim.
    out.reasoning_effort = thinking;
  }
}

function openAiUserContent(parts: IRContentPart[]): unknown {
  const onlyText = parts.every((p) => p.type === "text");
  if (onlyText) return parts.map((p) => (p as IRTextPart).text).join("");
  return parts.map((p) =>
    p.type === "image" ? imagePartToOpenAI(p.source) : { type: "text", text: (p as IRTextPart).text ?? "" },
  );
}

function irToolChoiceToOpenAI(choice: IRToolChoice): unknown {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
  }
}

// --- response: wire -> IR ------------------------------------------------

export function responseToIR(body: Record<string, unknown>): IRResponse {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (choice.message ?? {}) as Record<string, unknown>;

  const content: IRContentPart[] = [];
  // OpenAI reasoning models put thinking in "reasoning" or "reasoning_content".
  const reasoning = String(message.reasoning ?? message.reasoning_content ?? "");
  if (reasoning) content.push({ type: "reasoning", text: reasoning });
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    content.push(...(coerceContentToParts(message.content) as IRContentPart[]));
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const call = tc as Record<string, unknown>;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    content.push({
      type: "tool_use",
      id: String(call.id ?? genId("call")),
      name: String(fn.name ?? ""),
      input: safeJsonParse(fn.arguments),
    });
  }

  const usage = (body.usage ?? {}) as Record<string, unknown>;
  return {
    id: String(body.id ?? genId("chatcmpl")),
    model: String(body.model ?? ""),
    created: numOrUndef(body.created) ?? nowSeconds(),
    content,
    stopReason: finishReasonToIR(choice.finish_reason as string | null),
    usage: {
      promptTokens: numOrUndef(usage.prompt_tokens) ?? 0,
      completionTokens: numOrUndef(usage.completion_tokens) ?? 0,
      totalTokens:
        numOrUndef(usage.total_tokens) ??
        (numOrUndef(usage.prompt_tokens) ?? 0) + (numOrUndef(usage.completion_tokens) ?? 0),
    },
  };
}

// --- response: IR -> wire (client) ---------------------------------------

export function irToResponse(ir: IRResponse, ctx: ClientResponseCtx): Record<string, unknown> {
  const text = textOf(ir.content);
  const reasoningParts = ir.content.filter((p) => p.type === "reasoning");
  const toolUses = ir.content.filter((p) => p.type === "tool_use");
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (reasoningParts.length) {
    message.reasoning = reasoningParts.map((p) => (p as { text: string }).text).join("");
  }
  if (toolUses.length) {
    message.tool_calls = toolUses.map((tu) => ({
      id: (tu as { id: string }).id,
      type: "function",
      function: {
        name: (tu as { name: string }).name,
        arguments: JSON.stringify((tu as { input: unknown }).input ?? {}),
      },
    }));
  }
  return {
    id: ir.id,
    object: "chat.completion",
    created: ir.created,
    model: ctx.model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: irToFinishReason(ir.stopReason) }],
    usage: {
      prompt_tokens: ir.usage.promptTokens,
      completion_tokens: ir.usage.completionTokens,
      total_tokens: ir.usage.totalTokens,
    },
  };
}

// --- small helpers -------------------------------------------------------

function parseStop(v: unknown): string[] | undefined {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.map(String);
  return undefined;
}

export { irToFinishReason, finishReasonToIR };