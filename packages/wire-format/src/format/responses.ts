import { Request, type RenderTarget } from "../ir/request.js";
import { Response, type RenderOptions } from "../ir/response.js";
import {
  normalizeMessages,
  stripStaleReasoning,
  textOf,
  type ContentPart,
  type FileSource,
  type Message,
  type Tool,
  type ToolChoice,
} from "../ir/content.js";
import type { GenerationParams, ResponseFormat, ThinkingLevel } from "../ir/params.js";
import { ThinkingPolicy } from "../ir/thinking.js";
import { parseSSE, safeParseJson, type StreamContext, type StreamEvent } from "../ir/stream.js";
import { genId, nowSeconds } from "../ir/ids.js";
import {
  applyNonCanonical,
  boolOrUndef,
  capMaxTokens,
  collectPassthrough,
  imageUrlOf,
  num,
  numOrUndef,
  openAiCachedTokens,
  parseDataUrl,
  safeJsonParse,
  strOrUndef,
} from "./wire.js";
import { FormatConversionError } from "./errors.js";
import type { Usage } from "../ir/usage.js";
import { decodeReasoning, encodeReasoning, encodeRedacted } from "./reasoningBridge.js";
import { registerFormat } from "./registry.js";

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
      case "input_file": {
        const name = part.filename != null ? String(part.filename) : undefined;
        if (typeof part.file_url === "string" && part.file_url) {
          parts.push({ type: "file", source: { kind: "url", url: part.file_url }, name });
        } else if (typeof part.file_data === "string" && part.file_data) {
          const d = part.file_data;
          const src = d.startsWith("data:") ? parseDataUrl(d) : { kind: "base64" as const, mediaType: "application/pdf", data: d };
          parts.push({ type: "file", source: src.kind === "url" ? src : { kind: "base64", mediaType: src.mediaType, data: src.data }, name });
        } else if (typeof part.file_id === "string" && part.file_id) {
          // A handle into this API's own file storage. Kept so a Responses ->
          // Responses hop restores it verbatim; another family cannot resolve
          // it and now says so instead of dropping the attachment.
          parts.push({ type: "file", source: { kind: "file_id", id: part.file_id, family: "openai_responses" }, name });
        }
        break;
      }
      case "refusal":
        if (part.refusal) parts.push({ type: "text", text: String(part.refusal) });
        break;
    }
  }
  return parts;
}

/**
 * A canonical file source as this wire's `input_file` fields. Responses is the
 * one family that expresses all three shapes -- inline bytes, a remote URL, and
 * its own `file_id` -- so only a foreign file id is unrepresentable here.
 */
function inputFileRef(source: FileSource): Record<string, unknown> {
  switch (source.kind) {
    case "base64":
      return { file_data: `data:${source.mediaType};base64,${source.data}` };
    case "url":
      return { file_url: source.url };
    case "file_id":
      if (source.family !== "openai_responses") {
        throw new FormatConversionError(
          `cannot send a ${source.family} file_id ("${source.id}") to an OpenAI Responses provider: ` +
            `a file id only resolves in the API that issued it`,
        );
      }
      return { file_id: source.id };
  }
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
    if (tool.type !== "function" || !tool.name) {
      // Built-in tools (web_search, file_search, code_interpreter, mcp, ...):
      // keep verbatim for same-family replay instead of dropping them.
      if (tool.type) tools.push({ name: String(tool.name ?? tool.type), parameters: {}, raw: { family: "openai_responses", value: tool } });
      continue;
    }
    tools.push({
      name: String(tool.name),
      description: tool.description ? String(tool.description) : undefined,
      parameters: (tool.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
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

/** Every key this format models itself — parsed above, or emitted by `render`. */
const OWNED = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "store",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "max_output_tokens",
  "reasoning",
  "text",
  "parallel_tool_calls",
  "service_tier",
  "user",
]);

/**
 * Fields that name state living on the provider's side, which this proxy does
 * not have and must never pretend to.
 *
 * Provider egress is stateless (`store: false`). Hydrogen owns response IDs, so an
 * id a client holds is Hydrogen's invention -- the upstream has never seen it.
 * Relaying one asks the provider to continue a conversation that does not exist
 * there; at best it errors, at worst it answers against the wrong context.
 * `background` is here for the same reason in a different shape: it makes the
 * provider return a queued placeholder instead of an answer.
 *
 * The Responses controller resolves state locally before entering the format
 * layer. Strip these fields here as well so internal calls and passthrough can
 * never delegate Hydrogen-owned history or background jobs to the provider.
 */
const PROVIDER_STATE = new Set(["previous_response_id", "conversation", "background", "prompt"]);

const RESERVED = new Set([...OWNED, ...PROVIDER_STATE]);

function parseParams(body: Record<string, unknown>): GenerationParams {
  const params: GenerationParams = {};
  if (numOrUndef(body.temperature) != null) params.temperature = numOrUndef(body.temperature);
  if (numOrUndef(body.top_p) != null) params.topP = numOrUndef(body.top_p);
  if (numOrUndef(body.max_output_tokens) != null) params.maxTokens = numOrUndef(body.max_output_tokens);
  if (body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) params.responsesReasoning = { ...body.reasoning as Record<string, unknown> };
  if (body.text && typeof body.text === "object" && !Array.isArray(body.text)) {
    params.responsesText = { ...body.text as Record<string, unknown> };
    const verbosity = params.responsesText.verbosity;
    if (verbosity === "low" || verbosity === "medium" || verbosity === "high") params.verbosity = verbosity;
  }
  const thinking = parseThinking(body.reasoning);
  if (thinking) params.thinking = thinking;
  const rf = parseResponseFormat(body.text);
  if (rf) params.responseFormat = rf;
  if (boolOrUndef(body.parallel_tool_calls) != null) params.parallelToolCalls = boolOrUndef(body.parallel_tool_calls);
  if (strOrUndef(body.service_tier) != null) params.serviceTier = strOrUndef(body.service_tier);
  if (strOrUndef(body.user) != null) params.user = strOrUndef(body.user);
  if (body.prompt_cache_key != null || body.prompt_cache_options != null) params.cacheHint = true;
  const passthrough = collectPassthrough(body, RESERVED, "openai_responses");
  if (passthrough) params.passthrough = passthrough;
  return params;
}

/** The reasoning text a "reasoning" item carries. The raw chain of thought
 * rides in `content` as `reasoning_text` parts (open-weight and compatible
 * servers), a summary in `summary` as `summary_text`; prefer the raw text. */
function reasoningItemText(item: Record<string, unknown>): string {
  const joinTexts = (list: unknown, type: string): string =>
    (Array.isArray(list) ? list : [])
      .map((s) => {
        if (!s || typeof s !== "object") return "";
        const part = s as Record<string, unknown>;
        return part.type === type ? String(part.text ?? "") : "";
      })
      .filter(Boolean)
      .join("\n");
  return joinTexts(item.content, "reasoning_text") || joinTexts(item.summary, "summary_text");
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
        } else if (type === "reasoning") {
          // Replayed thinking is parsed, NOT dropped: what may be resent is the
          // EGRESS family's rule. An Anthropic-family target requires the
          // history's thinking back (DeepSeek's 4028), and this family's own
          // render replays it too — DeepSeek-family Responses upstreams 400 a
          // thinking-mode tool loop whose reasoning_text is not passed back.
          // encrypted_content and the item id ride along so a same-family
          // replay restores the item. A reasoning item precedes its turn's
          // message/function_call items, so normalizeMessages folds it in
          // front of them — the order every family wants.
          const text = reasoningItemText(item);
          const encrypted = typeof item.encrypted_content === "string" && item.encrypted_content ? item.encrypted_content : undefined;
          // An Anthropic redacted block this proxy wrapped on the way out (see
          // reasoningBridge): unwrap it so the canonical part is the redacted
          // block again, and an Anthropic upstream gets the real thing back.
          const unwrapped = encrypted ? decodeReasoning(encrypted) : null;
          if (unwrapped) {
            messages.push({ role: "assistant", content: [unwrapped] });
          } else if (text || encrypted) {
            messages.push({
              role: "assistant",
              content: [{
                type: "reasoning",
                text,
                signature: encrypted,
                origin: "openai_responses",
                itemId: typeof item.id === "string" && item.id ? item.id : undefined,
              }],
            });
          }
        }
      }
    }

    return new OpenAIResponsesRequest({
      requestedService: String(body.model ?? ""),
      system: systemChunks.length ? systemChunks.join("\n\n") : undefined,
      // Reasoning is NOT stripped here: what a target may be sent back is the
      // egress family's rule, applied at render time (this family and the
      // Anthropic renderer both replay it; stale tool-less turns are shed by
      // stripStaleReasoning in the renderers that call it).
      messages: normalizeMessages(messages),
      tools: parseTools(body.tools),
      toolChoice: parseToolChoice(body.tool_choice),
      params: parseParams(body),
      stream: Boolean(body.stream),
    });
  }

  render(target: RenderTarget): Record<string, unknown> {
    const input: Record<string, unknown>[] = [];
    // Stale (tool-less prior-turn) reasoning is shed; tool-call turns keep
    // theirs -- DeepSeek-family Responses upstreams 400 a thinking-mode tool
    // loop whose reasoning_text is not passed back.
    for (const m of stripStaleReasoning(this.messages)) {
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
        } else if (p.type === "file") {
          parts.push({ type: "input_file", ...(p.name ? { filename: p.name } : {}), ...inputFileRef(p.source) });
        } else if (p.type === "opaque") {
          if (p.family === "openai_responses") parts.push(p.value as Record<string, unknown>);
        } else if (p.type === "tool_use") {
          flushParts();
          input.push({ type: "function_call", call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}) });
        } else if (p.type === "tool_result") {
          flushParts();
          input.push({ type: "function_call_output", call_id: p.toolUseId, output: textOf(p.content) });
          // function_call_output is text-only: carry the result's images in a
          // follow-up user message instead of dropping them (screenshot loops).
          const images = p.content.filter((c) => c.type === "image");
          if (images.length) {
            input.push({
              role: "user",
              content: [
                { type: "input_text", text: "(images returned by the tool result above)" },
                ...images.map((img) => ({ type: "input_image", image_url: imageUrlOf((img as Extract<ContentPart, { type: "image" }>).source) })),
              ],
            });
          }
        } else if (p.type === "reasoning") {
          // Replay reasoning ahead of the action it informed. DeepSeek-family
          // upstreams require the reasoning_text back in thinking-mode tool
          // loops; OpenAI pairs a replayed item with its original id and
          // encrypted_content, both preserved when the client sent them.
          // An Anthropic redacted block is not replayable here at all: only the
          // family that encrypted it can read it back.
          if (p.redacted) continue;
          flushParts();
          input.push({
            type: "reasoning",
            id: (!p.origin || p.origin === "openai_responses" ? p.itemId : undefined) ?? genId("rs"),
            summary: p.text ? [{ type: "summary_text", text: p.text }] : [],
            ...(p.text ? { content: [{ type: "reasoning_text", text: p.text }] } : {}),
            ...(p.signature && (!p.origin || p.origin === "openai_responses") ? { encrypted_content: p.signature } : {}),
          });
        }
      }
      flushParts();
    }

    const p = this.params;
    // Provider-side storage is disabled; Hydrogen manages ingress state locally.
    const out: Record<string, unknown> = { model: target.upstreamModel, input, store: false };
    if (this.system) out.instructions = this.system;
    if (this.tools) {
      const rendered = this.tools
        .filter((t) => !t.raw || t.raw.family === "openai_responses")
        .map((t) => (t.raw ? t.raw.value : { type: "function", name: t.name, description: t.description, parameters: t.parameters, ...(t.strict != null ? { strict: t.strict } : {}) }));
      if (rendered.length) out.tools = rendered;
    }
    if (this.toolChoice) out.tool_choice = toolChoiceToResponses(this.toolChoice);
    if (p.responsesReasoning) out.reasoning = { ...p.responsesReasoning };
    if (p.responsesText) out.text = { ...p.responsesText };
    if (p.thinking) {
      // The thinking policy owns max_output_tokens when reasoning is on: the
      // reasoning is spent out of that same ceiling, so it has to size it.
      const tf = ThinkingPolicy.responses(p.thinking, p.maxTokens, target.providerMaxOutputTokens);
      out.reasoning = { ...p.responsesReasoning, effort: tf.effort };
      if (tf.maxTokens != null) out.max_output_tokens = tf.maxTokens;
    } else {
      const maxTokens = capMaxTokens(p.maxTokens, target.providerMaxOutputTokens);
      if (maxTokens != null) out.max_output_tokens = maxTokens;
    }
    if (p.temperature != null) out.temperature = p.temperature;
    if (p.topP != null) out.top_p = p.topP;
    if (p.responseFormat) out.text = { ...p.responsesText, ...responseFormatToResponses(p.responseFormat) as Record<string, unknown> };
    if (p.verbosity) out.text = { ...out.text as Record<string, unknown>, verbosity: p.verbosity };
    if (p.parallelToolCalls != null) out.parallel_tool_calls = p.parallelToolCalls;
    if (p.serviceTier != null) out.service_tier = p.serviceTier;
    if (p.user != null) out.user = p.user;
    if (this.stream) out.stream = true;
    applyNonCanonical(out, p, this.family);
    return out;
  }

  /** Rebuild any canonical Request as an OpenAI Responses request. */
  static construct(base: Request): OpenAIResponsesRequest {
    return new OpenAIResponsesRequest(base.data());
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
        // Raw chain of thought (content[].reasoning_text) or summary, whichever
        // the server produced. encrypted_content and the item id are kept so a
        // replay can restore the item.
        const text = reasoningItemText(item);
        const encrypted = typeof item.encrypted_content === "string" && item.encrypted_content ? item.encrypted_content : undefined;
        if (text || encrypted) {
          content.push((encrypted ? decodeReasoning(encrypted) : null) ?? {
            type: "reasoning",
            text,
            signature: encrypted,
            origin: "openai_responses",
            itemId: typeof item.id === "string" && item.id ? item.id : undefined,
          });
        }
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
    const cachedInputTokens = openAiCachedTokens(usage);
    const reasoningTokens = numOrUndef(((usage.output_tokens_details ?? {}) as Record<string, unknown>).reasoning_tokens);
    const incomplete = body.status === "incomplete";
    return new OpenAIResponsesResponse({
      id: String(body.id ?? genId("resp")),
      model: String(body.model ?? ""),
      created: numOrUndef(body.created_at) ?? 0,
      content,
      stopReason: incomplete ? "length" : sawToolCall ? "tool_use" : "stop",
      usage: {
        promptTokens, completionTokens, totalTokens: numOrUndef(usage.total_tokens) ?? promptTokens + completionTokens,
        ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
        ...(reasoningTokens != null ? { reasoningTokens } : {}),
      },
    });
  }

  /** See the note on AnthropicResponse.renderSelf: this wire has one native
   * reasoning item and no field name to choose. */
  renderSelf(model: string, _opts?: RenderOptions): Record<string, unknown> {
    const output: Record<string, unknown>[] = [];

    for (const p of this.content) {
      if (p.type !== "reasoning" || (!p.text && !p.signature)) continue;
      // A redacted block goes to the CLIENT wrapped, so the next turn can hand
      // it back and reach an Anthropic upstream intact. This is the one place
      // the envelope is created; requests bound for an upstream never carry it.
      if (p.redacted) {
        output.push({
          type: "reasoning",
          id: p.itemId ?? genId("rs"),
          summary: [],
          encrypted_content: encodeRedacted(p),
        });
        continue;
      }
      output.push({
        type: "reasoning",
        id: p.itemId ?? genId("rs"),
        summary: p.text ? [{ type: "summary_text", text: p.text }] : [],
        ...(p.text ? { content: [{ type: "reasoning_text", text: p.text }] } : {}),
        ...(p.signature ? { encrypted_content: p.origin && p.origin !== "openai_responses" ? encodeReasoning(p) : p.signature } : {}),
      });
    }

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
      usage: {
        input_tokens: this.usage.promptTokens, output_tokens: this.usage.completionTokens, total_tokens: this.usage.totalTokens,
        ...(this.usage.cachedInputTokens != null ? { input_tokens_details: { cached_tokens: this.usage.cachedInputTokens } } : {}),
        ...(this.usage.reasoningTokens != null ? { output_tokens_details: { reasoning_tokens: this.usage.reasoningTokens } } : {}),
      },
    };
  }

  static async *parseStream(readable: AsyncIterable<Buffer | string>): AsyncGenerator<StreamEvent> {
    let started = false;
    let sawToolCall = false;
    let usage: Usage | undefined;
    const toolIndexByItem = new Map<string, number>();
    const reasoningStarted = new Set<string>();
    const reasoningWithText = new Set<string>();
    let currentReasoningId: string | undefined;
    let nextToolIndex = 0;
    // Some compatible gateways put the answer only in done/completed snapshots.
    // Track each content part so snapshots fill missing suffixes without replaying
    // text that has already reached the client through deltas.
    const textByItem = new Map<string, Map<number, string>>();
    const textByIndex = new Map<number, Map<number, string>>();
    const textState = (id: unknown, index: unknown): Map<number, string> => {
      const itemId = typeof id === "string" ? id : undefined;
      const outputIndex = typeof index === "number" ? index : itemId ? undefined : 0;
      const state = (itemId ? textByItem.get(itemId) : undefined) ??
        (outputIndex != null ? textByIndex.get(outputIndex) : undefined) ?? new Map<number, string>();
      if (itemId) textByItem.set(itemId, state);
      if (outputIndex != null) textByIndex.set(outputIndex, state);
      return state;
    };
    function* emitText(data: Record<string, unknown>, text: unknown, snapshot: boolean): Generator<StreamEvent> {
      if (typeof text !== "string" || !text) return;
      const state = textState(data.item_id, data.output_index);
      const part = num(data.content_index);
      const previous = state.get(part) ?? "";
      // A snapshot cannot revise bytes already streamed. Only append its unseen
      // suffix when it agrees with the emitted prefix.
      const delta = snapshot ? (text.startsWith(previous) ? text.slice(previous.length) : "") : text;
      if (delta) {
        state.set(part, previous + delta);
        yield { type: "text_delta", text: delta };
      }
    }
    function* emitMessage(item: Record<string, unknown>, outputIndex: unknown): Generator<StreamEvent> {
      if (item.type !== "message" || !Array.isArray(item.content)) return;
      for (const [contentIndex, raw] of item.content.entries()) {
        if (!raw || typeof raw !== "object") continue;
        const part = raw as Record<string, unknown>;
        if (part.type === "output_text" || part.type === "text" || part.type === "refusal") {
          yield* emitText({ item_id: item.id, output_index: outputIndex, content_index: contentIndex }, part.type === "refusal" ? part.refusal : part.text, true);
        }
      }
    }

    const finishedItems = new Set<string>();
    const toolArguments = new Map<number, string>();
    function* finishItem(item: Record<string, unknown>, outputIndex: unknown): Generator<StreamEvent> {
      if (item.type === "message") { yield* emitMessage(item, outputIndex); return; }
      const itemId = String(item.id ?? item.call_id ?? (item.type === "reasoning" ? currentReasoningId : undefined) ?? outputIndex ?? "0");
      const key = String(item.type) + ":" + itemId;
      if (finishedItems.has(key)) return;
      if (item.type === "reasoning") {
        if (!reasoningStarted.has(itemId)) {
          reasoningStarted.add(itemId);
          yield { type: "reasoning_start", origin: "openai_responses", id: itemId };
        }
        if (!reasoningWithText.has(itemId)) {
          const text = reasoningItemText(item);
          if (text) yield { type: "reasoning_delta", text };
        }
        const encrypted = typeof item.encrypted_content === "string" && item.encrypted_content ? item.encrypted_content : undefined;
        const replay = encrypted ? decodeReasoning(encrypted) : null;
        yield { type: "reasoning_stop", origin: replay?.origin ?? "openai_responses", id: replay?.itemId ?? itemId, signature: replay?.signature ?? encrypted, redacted: replay?.redacted };
        if (currentReasoningId === itemId) currentReasoningId = undefined;
      } else if (item.type === "function_call") {
        sawToolCall = true;
        let index = toolIndexByItem.get(itemId);
        if (index == null) {
          index = nextToolIndex++;
          toolIndexByItem.set(itemId, index);
          yield { type: "tool_start", index, id: String(item.call_id ?? item.id ?? genId("call")), name: String(item.name ?? "") };
        }
        const args = typeof item.arguments === "string" ? item.arguments : "";
        const previous = toolArguments.get(index) ?? "";
        if (args.startsWith(previous) && args.length > previous.length) {
          yield { type: "tool_args_delta", index, delta: args.slice(previous.length) };
        }
        yield { type: "tool_stop", index };
      }
      finishedItems.add(key);
    }

    for await (const frame of parseSSE(readable)) {
      const data = safeParseJson(frame.data);
      if (!data) continue;
      const type = frame.event ?? String(data.type ?? "");

      if (!started && type.startsWith("response.")) {
        const r = (data.response ?? {}) as Record<string, unknown>;
        started = true;
        yield { type: "start", id: String(r.id ?? genId("resp")), model: String(r.model ?? ""), created: num(r.created_at) || nowSeconds() };
      }

      switch (type) {
        case "response.created": {
          break;
        }
        case "response.output_text.delta":
        case "response.refusal.delta":
          yield* emitText(data, data.delta, false);
          break;
        case "response.output_text.done":
          yield* emitText(data, data.text, true);
          break;
        case "response.refusal.done":
          yield* emitText(data, data.refusal, true);
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": {
          const itemId = typeof data.item_id === "string" && data.item_id ? data.item_id : currentReasoningId;
          if (itemId && !reasoningStarted.has(itemId)) {
            reasoningStarted.add(itemId);
            currentReasoningId = itemId;
            yield { type: "reasoning_start", origin: "openai_responses", id: itemId };
          }
          if (typeof data.delta === "string" && data.delta) {
            reasoningWithText.add(itemId ?? "");
            yield { type: "reasoning_delta", text: data.delta };
          }
          break;
        }
        case "response.output_item.added": {
          const item = (data.item ?? {}) as Record<string, unknown>;
          if (item.type === "reasoning") {
            const itemId = String(item.id ?? genId("rs"));
            currentReasoningId = itemId;
            if (!reasoningStarted.has(itemId)) {
              reasoningStarted.add(itemId);
              yield { type: "reasoning_start", origin: "openai_responses", id: itemId };
            }
          } else if (item.type === "function_call") {
            sawToolCall = true;
            const index = nextToolIndex++;
            toolIndexByItem.set(String(item.id ?? item.call_id ?? index), index);
            yield { type: "tool_start", index, id: String(item.call_id ?? item.id ?? genId("call")), name: String(item.name ?? "") };
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const index = toolIndexByItem.get(String(data.item_id ?? ""));
          if (index != null && typeof data.delta === "string" && data.delta) {
            toolArguments.set(index, (toolArguments.get(index) ?? "") + data.delta);
            yield { type: "tool_args_delta", index, delta: data.delta };
          }
          break;
        }
        case "response.output_item.done": {
          yield* finishItem((data.item ?? {}) as Record<string, unknown>, data.output_index);
          break;
        }
        case "response.completed":
        case "response.incomplete":
        case "response.failed": {
          const r = (data.response ?? {}) as Record<string, unknown>;
          const u = (r.usage ?? {}) as Record<string, unknown>;
          if (u.input_tokens != null || u.output_tokens != null) {
            const otd = (u.output_tokens_details ?? {}) as Record<string, unknown>;
            const cached = openAiCachedTokens(u);
            usage = {
              promptTokens: num(u.input_tokens), completionTokens: num(u.output_tokens), totalTokens: num(u.total_tokens) || num(u.input_tokens) + num(u.output_tokens),
              ...(cached != null ? { cachedInputTokens: cached } : {}),
              ...(numOrUndef(otd.reasoning_tokens) != null ? { reasoningTokens: num(otd.reasoning_tokens) } : {}),
            };
          }
          // A failed generation is not an answer: flag it incomplete so the
          // buffered path reports a retryable failure and the streamed path
          // aborts the connection, instead of relaying a failure as a completed
          // response. `incomplete` (max_output_tokens) is a legitimate length
          // stop and stays a normal finish.
          if (type === "response.failed") {
            yield { type: "finish", stopReason: sawToolCall ? "tool_use" : "stop", usage, incomplete: true };
            return;
          }
          if (!started) {
            started = true;
            yield { type: "start", id: String(r.id ?? genId("resp")), model: String(r.model ?? ""), created: num(r.created_at) || nowSeconds() };
          }
          if (Array.isArray(r.output)) {
            for (const [index, item] of r.output.entries()) {
              if (item && typeof item === "object") yield* finishItem(item as Record<string, unknown>, index);
            }
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
    let reasoningSignature: string | undefined;
    const tools = new Map<number, { itemId: string; callId: string; name: string; args: string; index: number }>();

    function* openReasoning(itemId?: string): Generator<string> {
      reasoningId = itemId || genId("rs");
      reasoningText = "";
      reasoningSignature = undefined;
      yield frame("response.output_item.added", { output_index: outputIndex, item: { id: reasoningId, type: "reasoning", summary: [] } });
      yield frame("response.reasoning_summary_part.added", { item_id: reasoningId, output_index: outputIndex, summary_index: 0, part: { type: "summary_text", text: "" } });
    }

    function* closeReasoning(): Generator<string> {
      if (reasoningText == null) return;
      const summary = reasoningText ? [{ type: "summary_text", text: reasoningText }] : [];
      const item = {
        id: reasoningId,
        type: "reasoning",
        summary,
        ...(reasoningText ? { content: [{ type: "reasoning_text", text: reasoningText }] } : {}),
        ...(reasoningSignature ? { encrypted_content: reasoningSignature } : {}),
      };
      if (reasoningText) {
        yield frame("response.reasoning_summary_text.done", { item_id: reasoningId, output_index: outputIndex, summary_index: 0, text: reasoningText });
        yield frame("response.reasoning_summary_part.done", { item_id: reasoningId, output_index: outputIndex, summary_index: 0, part: { type: "summary_text", text: reasoningText } });
      }
      yield frame("response.output_item.done", { output_index: outputIndex, item });
      output.push(item);
      outputIndex++;
      reasoningText = null;
      reasoningSignature = undefined;
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

    // An Anthropic redacted_thinking block has no native form here, so it is
    // emitted as a summary-less reasoning item whose encrypted_content is this
    // proxy's envelope (see reasoningBridge). The client replays the item next
    // turn, `parse` unwraps it, and an Anthropic upstream sees its own block
    // again -- which that upstream REQUIRES when the turn called tools.
    //
    // `redactedItemId` is set while such a block is open, so the deltas that
    // never come for it cannot accidentally open a normal reasoning item.
    let redactedItemId: string | null = null;

    for await (const ev of events) {
      switch (ev.type) {
        case "start":
          created = ev.created || created;
          yield frame("response.created", { response: response("in_progress") });
          yield frame("response.in_progress", { response: response("in_progress") });
          break;
        case "reasoning_start":
          if (ev.redacted) {
            yield* closeMessage();
            yield* closeReasoning();
            redactedItemId = ev.id || genId("rs");
            yield frame("response.output_item.added", {
              output_index: outputIndex,
              item: { id: redactedItemId, type: "reasoning", summary: [] },
            });
            break;
          }
          yield* closeMessage();
          yield* closeReasoning();
          yield* openReasoning(ev.id);
          break;
        case "reasoning_delta":
          if (redactedItemId) break; // a redacted block streams no text
          if (reasoningText == null) {
            yield* closeMessage();
            yield* openReasoning();
          }
          reasoningText = (reasoningText ?? "") + ev.text;
          yield frame("response.reasoning_summary_text.delta", { item_id: reasoningId, output_index: outputIndex, summary_index: 0, delta: ev.text });
          break;
        case "reasoning_stop":
          if (redactedItemId || ev.redacted) {
            const id = redactedItemId ?? ev.id ?? genId("rs");
            const item = {
              id,
              type: "reasoning",
              summary: [],
              encrypted_content: encodeRedacted({ type: "reasoning", text: "", redacted: true, signature: ev.signature }),
            };
            yield frame("response.output_item.done", { output_index: outputIndex, item });
            output.push(item);
            outputIndex++;
            redactedItemId = null;
            break;
          }
          if (reasoningText == null) {
            yield* closeMessage();
            yield* openReasoning(ev.id);
          }
          reasoningSignature = ev.signature && ev.origin && ev.origin !== "openai_responses"
            ? encodeReasoning({ type: "reasoning", text: reasoningText ?? "", signature: ev.signature, origin: ev.origin, itemId: ev.id }) : ev.signature;
          yield* closeReasoning();
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
          // A truncated upstream must not be dressed up as a finished answer:
          // no response.completed. relay() aborts the connection instead.
          if (ev.incomplete || ev.error) return;
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
            ? { input_tokens: ev.usage.promptTokens, output_tokens: ev.usage.completionTokens, total_tokens: ev.usage.totalTokens,
                ...(ev.usage.cachedInputTokens != null ? { input_tokens_details: { cached_tokens: ev.usage.cachedInputTokens } } : {}),
                ...(ev.usage.reasoningTokens != null ? { output_tokens_details: { reasoning_tokens: ev.usage.reasoningTokens } } : {}),
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
}

registerFormat("openai_responses", { request: OpenAIResponsesRequest, response: OpenAIResponsesResponse });
