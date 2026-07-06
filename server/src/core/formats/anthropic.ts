import {
  type IRContentPart,
  type IRImagePart,
  type IRMessage,
  type IRRequest,
  type IRResponse,
  type IRStopReason,
  type IRTextPart,
  type IRThinkingLevel,
  type IRToolChoice,
  type IRTool,
  normalizeMessages,
} from "../ir";
import { genId, nowSeconds } from "../../util/ids";
import { numOrUndef, pickExtra } from "./util";
import type { ClientResponseCtx } from "./openai";

/** Anthropic requires max_tokens; use this when the client didn't specify one. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

// --- stop reason mapping -------------------------------------------------

function stopReasonToIR(reason: string | null | undefined): IRStopReason {
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

function irToStopReason(reason: IRStopReason): string {
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

// --- block <-> part coercion --------------------------------------------

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

function blocksToParts(content: unknown): IRContentPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: IRContentPart[] = [];
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
        parts.push({
          type: "tool_use",
          id: String(b.id ?? genId("toolu")),
          name: String(b.name ?? ""),
          input: b.input ?? {},
        });
        break;
      case "tool_result":
        parts.push({
          type: "tool_result",
          toolUseId: String(b.tool_use_id ?? ""),
          content: blocksToParts(b.content).filter(
            (p): p is IRTextPart | IRImagePart => p.type === "text" || p.type === "image",
          ),
          isError: b.is_error === true ? true : undefined,
        });
        break;
    }
  }
  return parts;
}

function parseImageSource(source: unknown): IRImagePart["source"] {
  const s = (source ?? {}) as Record<string, unknown>;
  if (s.type === "url") return { kind: "url", url: String(s.url ?? "") };
  return {
    kind: "base64",
    mediaType: String(s.media_type ?? "image/png"),
    data: String(s.data ?? ""),
  };
}

function imageSourceToBlock(source: IRImagePart["source"]): unknown {
  if (source.kind === "url") return { type: "url", url: source.url };
  return { type: "base64", media_type: source.mediaType, data: source.data };
}

// --- request: wire -> IR -------------------------------------------------

export function requestToIR(body: Record<string, unknown>): IRRequest {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages: IRMessage[] = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const role = m.role === "assistant" ? "assistant" : "user";
    messages.push({ role, content: blocksToParts(m.content) });
  }

  const thinking = parseAnthropicThinking(body);

  return {
    requestedModel: String(body.model ?? ""),
    system: systemToText(body.system),
    messages: normalizeMessages(messages),
    tools: parseTools(body.tools),
    toolChoice: parseToolChoice(body.tool_choice),
    maxTokens: numOrUndef(body.max_tokens),
    temperature: numOrUndef(body.temperature),
    topP: numOrUndef(body.top_p),
    stop: Array.isArray(body.stop_sequences) ? body.stop_sequences.map(String) : undefined,
    stream: Boolean(body.stream),
    thinking,
    extra: pickExtra(body, ["top_k", "metadata"]),
  };
}

/** Parse the thinking configuration from an Anthropic-style request body. */
function parseAnthropicThinking(body: Record<string, unknown>): IRThinkingLevel | undefined {
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

function parseTools(raw: unknown): IRTool[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: IRTool[] = [];
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

function parseToolChoice(raw: unknown): IRToolChoice | undefined {
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

// --- request: IR -> wire (upstream) --------------------------------------

export function irToRequest(ir: IRRequest, upstreamModel: string): Record<string, unknown> {
  const messages = ir.messages.map((m) => ({
    role: m.role,
    content: partsToBlocks(m.content),
  }));

  const out: Record<string, unknown> = {
    model: upstreamModel,
    max_tokens: ir.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    messages,
  };
  if (ir.system) out.system = ir.system;
  if (ir.tools) {
    out.tools = ir.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (ir.toolChoice) out.tool_choice = irToolChoiceToAnthropic(ir.toolChoice);
  if (ir.temperature != null) out.temperature = ir.temperature;
  if (ir.topP != null) out.top_p = ir.topP;
  if (ir.stop && ir.stop.length) out.stop_sequences = ir.stop;
  if (ir.stream) out.stream = true;
  // Apply thinking/reasoning level to the upstream request. Pass the client's
  // own max_tokens (undefined if they set none, distinct from the default just
  // written to `out`) so the budget can fit under a real ceiling.
  if (ir.thinking) applyAnthropicThinking(out, ir.thinking, ir.maxTokens);
  if (ir.extra) Object.assign(out, ir.extra);
  return out;
}

/** Token budgets for the named effort levels (Anthropic has no effort field). */
const EFFORT_BUDGETS: Record<"low" | "medium" | "high" | "xhigh" | "max", number> = {
  low: 4096,
  medium: 16000,
  high: 32000,
  xhigh: 64000,
  max: 128000,
};

/**
 * Tokens reserved under max_tokens for the response text. Anthropic counts
 * thinking + response against the single max_tokens budget, so the effective
 * thinking budget must leave room beneath max_tokens for the actual answer.
 */
const THINKING_RESPONSE_ROOM = 4096;
/** Anthropic's minimum accepted thinking budget. */
const MIN_THINKING_BUDGET = 1024;

/** Translate an IRThinkingLevel into the Anthropic thinking parameter. */
function applyAnthropicThinking(
  out: Record<string, unknown>,
  thinking: IRThinkingLevel,
  clientMax: number | undefined,
): void {
  if (thinking === "disabled") {
    out.thinking = { type: "disabled" };
    return;
  }
  // Anthropic requires a budget; derive one from the level.
  let budget: number;
  if (thinking === "enabled" || thinking === "auto") {
    budget = clientMax != null ? Math.min(clientMax, 16000) : 16000;
  } else if (typeof thinking === "object") {
    budget = thinking.budget;
  } else {
    budget = EFFORT_BUDGETS[thinking];
  }
  budget = Math.max(MIN_THINKING_BUDGET, budget);

  // max_tokens bounds thinking + response together. When the client asked for a
  // specific max_tokens, treat it as the ceiling the upstream will accept and
  // fit the thinking budget under it -- shrinking the budget if need be --
  // rather than inflating max_tokens past what the client requested. Inflating
  // it can exceed the provider's own max_tokens limit (e.g. a large budget puts
  // budget+room over the cap), which gets the WHOLE request rejected, so the
  // client gets no thinking at all. Only when the client left max_tokens unset
  // do we size it to give the budget room.
  if (clientMax == null) {
    out.max_tokens = budget + THINKING_RESPONSE_ROOM;
  } else if (clientMax < budget + THINKING_RESPONSE_ROOM) {
    budget = Math.max(MIN_THINKING_BUDGET, clientMax - THINKING_RESPONSE_ROOM);
    // Keep the client's ceiling, but guarantee Anthropic's hard rule
    // (max_tokens > budget_tokens) even for a ceiling too small to hold the
    // minimum budget plus response room.
    out.max_tokens = clientMax <= budget ? budget + 1 : clientMax;
  } else {
    out.max_tokens = clientMax;
  }
  out.thinking = { type: "enabled", budget_tokens: budget };
}

function partsToBlocks(parts: IRContentPart[]): unknown[] {
  const blocks: unknown[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        blocks.push({ type: "text", text: p.text });
        break;
      case "reasoning":
        blocks.push({
          type: "thinking",
          thinking: p.text,
          ...(p.signature ? { signature: p.signature } : {}),
        });
        break;
      case "image":
        blocks.push({ type: "image", source: imageSourceToBlock(p.source) });
        break;
      case "tool_use":
        blocks.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
        break;
      case "tool_result":
        blocks.push({
          type: "tool_result",
          tool_use_id: p.toolUseId,
          content: partsToBlocks(p.content as IRContentPart[]),
          ...(p.isError ? { is_error: true } : {}),
        });
        break;
    }
  }
  return blocks;
}

function irToolChoiceToAnthropic(choice: IRToolChoice): unknown {
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

// --- response: wire -> IR ------------------------------------------------

export function responseToIR(body: Record<string, unknown>): IRResponse {
  const content = blocksToParts(body.content).filter(
    (p) => p.type === "text" || p.type === "tool_use" || p.type === "reasoning",
  );
  const usage = (body.usage ?? {}) as Record<string, unknown>;
  const promptTokens = numOrUndef(usage.input_tokens) ?? 0;
  const completionTokens = numOrUndef(usage.output_tokens) ?? 0;
  return {
    id: String(body.id ?? genId("msg")),
    model: String(body.model ?? ""),
    created: nowSeconds(),
    content,
    stopReason: stopReasonToIR(body.stop_reason as string | null),
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
  };
}

// --- response: IR -> wire (client) ---------------------------------------

export function irToResponse(ir: IRResponse, ctx: ClientResponseCtx): Record<string, unknown> {
  const content: unknown[] = [];
  for (const p of ir.content) {
    if (p.type === "reasoning") {
      content.push({
        type: "thinking",
        thinking: p.text,
        ...(p.signature ? { signature: p.signature } : {}),
      });
    } else if (p.type === "text") {
      content.push({ type: "text", text: p.text });
    } else if (p.type === "tool_use") {
      content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: ir.id,
    type: "message",
    role: "assistant",
    model: ctx.model,
    content,
    stop_reason: irToStopReason(ir.stopReason),
    stop_sequence: null,
    usage: { input_tokens: ir.usage.promptTokens, output_tokens: ir.usage.completionTokens },
  };
}

export { stopReasonToIR, irToStopReason };