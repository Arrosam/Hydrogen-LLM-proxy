import { Request, type RenderTarget } from "../ir/request";
import { Response, type RenderOptions } from "../ir/response";
import {
  normalizeMessages,
  stripStaleReasoning,
  textOf,
  type ContentPart,
  type Message,
  type StopReason,
  type TextPart,
  type Tool,
  type ToolChoice,
} from "../ir/content";
import type { GenerationParams, ResponseFormat, ThinkingLevel } from "../ir/params";
import { ThinkingPolicy } from "../ir/thinking";
import { parseSSE, safeParseJson, type ResponseData, type StreamContext, type StreamEvent } from "../ir/stream";
import { genId, nowSeconds } from "../../util/ids";
import {
  applyNonCanonical,
  boolOrUndef,
  capMaxTokens,
  collectPassthrough,
  num,
  numOrUndef,
  openAiCachedTokens,
  parseDataUrl,
  parseStop,
  safeJsonParse,
  strOrUndef,
} from "./wire";
import { FormatConversionError } from "./errors";
import { registerFormat } from "./registry";
import type { SendTarget, Transport } from "../upstream/transport";
import type { RelayResult, SendResult } from "../upstream/outcome";
import { relayStream, sendBuffered } from "../upstream/roundtrip";

// --- stop reason mapping -------------------------------------------------

function finishReasonToStop(reason: string | null | undefined): StopReason {
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

function stopToFinishReason(reason: StopReason): string {
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

function coerceContentToParts(content: unknown): ContentPart[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const t = (item as Record<string, unknown>).type;
    if (t === "text" || t === "input_text" || t === "output_text") {
      parts.push({ type: "text", text: String((item as Record<string, unknown>).text ?? "") });
    } else if (t === "image_url") {
      const img = (item as Record<string, unknown>).image_url as Record<string, unknown> | string;
      const url = typeof img === "string" ? img : String(img?.url ?? "");
      parts.push({ type: "image", source: parseDataUrl(url) });
    } else if (t === "file") {
      const f = ((item as Record<string, unknown>).file ?? {}) as Record<string, unknown>;
      const name = f.filename != null ? String(f.filename) : undefined;
      const data = String(f.file_data ?? "");
      const fileId = strOrUndef(f.file_id);
      if (data) {
        const src = data.startsWith("data:") ? parseDataUrl(data) : { kind: "base64" as const, mediaType: "application/pdf", data };
        parts.push({ type: "file", source: src.kind === "url" ? src : { kind: "base64", mediaType: src.mediaType, data: src.data }, name });
      } else if (fileId) {
        // Kept rather than dropped: a same-family replay restores the reference
        // exactly, and any other family now rejects it loudly instead of
        // quietly sending a request with the attachment missing.
        parts.push({ type: "file", source: { kind: "file_id", id: fileId, family: "openai_completion" }, name });
      }
    } else if (t === "input_audio") {
      // No canonical audio type: keep verbatim for same-family replay.
      parts.push({ type: "opaque", family: "openai_completion", value: item });
    }
  }
  return parts;
}

function imagePartToOpenAI(source: (ContentPart & { type: "image" })["source"]): unknown {
  const url = source.kind === "base64" ? `data:${source.mediaType};base64,${source.data}` : source.url;
  return { type: "image_url", image_url: { url } };
}

/**
 * This wire carries a file either inline (`file_data`, a base64 data URL) or as
 * a handle into the provider's own storage (`file_id`). It has no field for a
 * remote URL.
 *
 * A URL used to be written into `file_data` verbatim. That field means "the
 * file's bytes", so the upstream saw a document whose content was the literal
 * string "https://..." -- most OpenAI-compatible servers reject the request
 * outright, and one that doesn't silently answers about the wrong content.
 *
 * A URL normally never reaches this point: the file pre-pass downloads it and
 * hands the renderer real bytes before this family is rendered (see
 * execution/fileFetch.ts). Rendering is synchronous and cannot fetch, so if one
 * does arrive here -- a transport with no GET, a caller rendering directly --
 * the only honest answer is to fail loudly rather than invent a document.
 */
function filePartToOpenAI(p: Extract<ContentPart, { type: "file" }>): unknown {
  const named = p.name ? { filename: p.name } : {};
  switch (p.source.kind) {
    case "base64":
      return { type: "file", file: { ...named, file_data: `data:${p.source.mediaType};base64,${p.source.data}` } };
    case "file_id":
      if (p.source.family !== "openai_completion") {
        throw new FormatConversionError(
          `cannot send a ${p.source.family} file_id ("${p.source.id}") to an OpenAI Chat Completions provider: ` +
            `a file id only resolves in the API that issued it`,
        );
      }
      return { type: "file", file: { ...named, file_id: p.source.id } };
    case "url":
      throw new FormatConversionError(
        `cannot send a URL file attachment (${p.source.url}) to an OpenAI Chat Completions provider: ` +
          `this format carries files inline (file_data) or by file_id, and a URL is neither`,
      );
  }
}

function openAiUserContent(parts: ContentPart[]): unknown {
  const onlyText = parts.every((p) => p.type === "text");
  if (onlyText) return parts.map((p) => (p as TextPart).text).join("");
  const out: unknown[] = [];
  for (const p of parts) {
    if (p.type === "image") out.push(imagePartToOpenAI(p.source));
    else if (p.type === "file") out.push(filePartToOpenAI(p));
    else if (p.type === "opaque") { if (p.family === "openai_completion") out.push(p.value); }
    else if (p.type === "text") out.push({ type: "text", text: p.text });
  }
  return out;
}

// --- tools ---------------------------------------------------------------

function parseTools(raw: unknown): Tool[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: Tool[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const entry = t as Record<string, unknown>;
    const fn = (entry.function ?? {}) as Record<string, unknown>;
    if (!fn.name) {
      // Built-in / custom tool types this format cannot model: keep verbatim
      // for same-family replay instead of silently dropping them.
      if (entry.type) tools.push({ name: String(entry.type), parameters: {}, raw: { family: "openai_completion", value: entry } });
      continue;
    }
    tools.push({
      name: String(fn.name),
      description: fn.description ? String(fn.description) : undefined,
      parameters: (fn.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
      ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
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
    const fn = ((raw as Record<string, unknown>).function ?? {}) as Record<string, unknown>;
    if (fn.name) return { type: "tool", name: String(fn.name) };
  }
  return undefined;
}

function toolChoiceToOpenAI(choice: ToolChoice): unknown {
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

// --- response_format -----------------------------------------------------

function parseResponseFormat(raw: unknown): ResponseFormat | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rf = raw as Record<string, unknown>;
  if (rf.type === "text") return { type: "text" };
  if (rf.type === "json_object") return { type: "json_object" };
  if (rf.type === "json_schema") {
    const js = (rf.json_schema ?? {}) as Record<string, unknown>;
    const schema = (js.schema as Record<string, unknown>) ?? {};
    return {
      type: "json_schema",
      name: js.name ? String(js.name) : undefined,
      schema,
      strict: typeof js.strict === "boolean" ? js.strict : undefined,
    };
  }
  return undefined;
}

function responseFormatToOpenAI(rf: ResponseFormat): unknown {
  if (rf.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: rf.name ?? "schema",
        schema: rf.schema,
        ...(rf.strict != null ? { strict: rf.strict } : {}),
      },
    };
  }
  return { type: rf.type };
}

// --- thinking ------------------------------------------------------------

function parseThinking(body: Record<string, unknown>): ThinkingLevel | undefined {
  const effort = body.reasoning_effort;
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
  if (typeof body.max_completion_tokens === "number" && body.reasoning_effort != null) {
    return { budget: body.max_completion_tokens as number };
  }
  return undefined;
}

// --- params --------------------------------------------------------------

/** Every key this format models itself — parsed below, or emitted by `render`. */
const RESERVED = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "seed",
  "n",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "response_format",
  "parallel_tool_calls",
  "service_tier",
  "user",
  "verbosity",
  "reasoning_effort",
]);

function parseParams(body: Record<string, unknown>): GenerationParams {
  const params: GenerationParams = {};
  const set = <K extends keyof GenerationParams>(k: K, v: GenerationParams[K] | undefined): void => {
    if (v !== undefined) params[k] = v;
  };
  set("temperature", numOrUndef(body.temperature));
  set("topP", numOrUndef(body.top_p));
  set("topK", numOrUndef(body.top_k));
  set("minP", numOrUndef(body.min_p));
  set("maxTokens", numOrUndef(body.max_completion_tokens) ?? numOrUndef(body.max_tokens));
  set("stop", parseStop(body.stop));
  set("frequencyPenalty", numOrUndef(body.frequency_penalty));
  set("presencePenalty", numOrUndef(body.presence_penalty));
  set("repetitionPenalty", numOrUndef(body.repetition_penalty));
  set("seed", numOrUndef(body.seed));
  set("n", numOrUndef(body.n));
  set("logprobs", boolOrUndef(body.logprobs));
  set("topLogprobs", numOrUndef(body.top_logprobs));
  if (body.logit_bias && typeof body.logit_bias === "object") {
    params.logitBias = body.logit_bias as Record<string, number>;
  }
  set("responseFormat", parseResponseFormat(body.response_format));
  set("parallelToolCalls", boolOrUndef(body.parallel_tool_calls));
  set("serviceTier", strOrUndef(body.service_tier));
  set("user", strOrUndef(body.user));
  if (body.verbosity === "low" || body.verbosity === "medium" || body.verbosity === "high") {
    params.verbosity = body.verbosity;
  }
  set("thinking", parseThinking(body));
  // OpenAI's caching is automatic; the presence of its tuning params is the
  // client saying "this conversation repeats" — enough to auto-plant an
  // Anthropic breakpoint on a cross-family hop.
  if (body.prompt_cache_key != null || body.prompt_cache_options != null) params.cacheHint = true;
  set("passthrough", collectPassthrough(body, RESERVED, "openai_completion"));
  return params;
}

/** Map canonical params onto the OpenAI Chat Completions wire body. `max_tokens`
 * is set by the caller, not here, because when reasoning is on the thinking
 * policy owns it (reasoning is billed inside the same ceiling). */
function applyParams(out: Record<string, unknown>, p: GenerationParams): void {
  if (p.temperature != null) out.temperature = p.temperature;
  if (p.topP != null) out.top_p = p.topP;
  if (p.topK != null) out.top_k = p.topK;
  if (p.minP != null) out.min_p = p.minP;
  if (p.stop && p.stop.length) out.stop = p.stop.slice(0, 4); // OpenAI wire allows at most 4
  if (p.frequencyPenalty != null) out.frequency_penalty = p.frequencyPenalty;
  if (p.presencePenalty != null) out.presence_penalty = p.presencePenalty;
  if (p.repetitionPenalty != null) out.repetition_penalty = p.repetitionPenalty;
  if (p.seed != null) out.seed = p.seed;
  if (p.n != null) out.n = p.n;
  if (p.logprobs != null) out.logprobs = p.logprobs;
  if (p.topLogprobs != null) out.top_logprobs = p.topLogprobs;
  if (p.logitBias) out.logit_bias = p.logitBias;
  if (p.responseFormat) out.response_format = responseFormatToOpenAI(p.responseFormat);
  if (p.parallelToolCalls != null) out.parallel_tool_calls = p.parallelToolCalls;
  if (p.serviceTier != null) out.service_tier = p.serviceTier;
  if (p.user != null) out.user = p.user;
  if (p.verbosity != null) out.verbosity = p.verbosity;
}

// --- request subclass ----------------------------------------------------

export class OpenAICompletionRequest extends Request {
  readonly family = "openai_completion" as const;

  static parse(body: Record<string, unknown>): OpenAICompletionRequest {
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const systemChunks: string[] = [];
    const messages: Message[] = [];

    for (const raw of rawMessages) {
      if (!raw || typeof raw !== "object") continue;
      const msg = raw as Record<string, unknown>;
      const role = String(msg.role);

      if (role === "system" || role === "developer") {
        const text =
          typeof msg.content === "string" ? msg.content : textOf(coerceContentToParts(msg.content));
        if (text) systemChunks.push(text);
        continue;
      }

      if (role === "tool") {
        const resultText =
          typeof msg.content === "string" ? msg.content : textOf(coerceContentToParts(msg.content));
        messages.push({
          role: "user",
          content: [{ type: "tool_result", toolUseId: String(msg.tool_call_id ?? ""), content: [{ type: "text", text: resultText }] }],
        });
        continue;
      }

      const name = typeof msg.name === "string" && msg.name ? msg.name : undefined;
      if (role === "assistant") {
        const content = coerceContentToParts(msg.content);
        // Providers disagree on the field name: DeepSeek says reasoning_content,
        // OpenRouter-style gateways say reasoning, some v4 gateways say
        // reasoning_text. Accept them all.
        const reasoning = String(msg.reasoning ?? msg.reasoning_content ?? msg.reasoning_text ?? "");
        if (reasoning) content.push({ type: "reasoning", text: reasoning });
        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        for (const tc of toolCalls) {
          if (!tc || typeof tc !== "object") continue;
          const call = tc as Record<string, unknown>;
          const fn = (call.function ?? {}) as Record<string, unknown>;
          content.push({ type: "tool_use", id: String(call.id ?? genId("call")), name: String(fn.name ?? ""), input: safeJsonParse(fn.arguments) });
        }
        messages.push({ role: "assistant", content, ...(name ? { name } : {}) });
        continue;
      }

      messages.push({ role: "user", content: coerceContentToParts(msg.content), ...(name ? { name } : {}) });
    }

    return new OpenAICompletionRequest({
      requestedService: String(body.model ?? ""),
      system: systemChunks.length ? systemChunks.join("\n\n") : undefined,
      // Reasoning is NOT stripped here: what a target may be sent back is the
      // egress family's rule, applied in render().
      messages: normalizeMessages(messages),
      tools: parseTools(body.tools),
      toolChoice: parseToolChoice(body.tool_choice),
      params: parseParams(body),
      stream: Boolean(body.stream),
    });
  }

  render(target: RenderTarget): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    if (this.system) messages.push({ role: "system", content: this.system });

    // Prior turns' reasoning is dropped on the way out: DeepSeek's
    // OpenAI-compatible endpoint rejects reasoning_content sent back to it, and
    // the rest of the family ignores it.
    for (const m of stripStaleReasoning(this.messages)) {
      if (m.role === "assistant") {
        const textParts = m.content.filter((p): p is TextPart => p.type === "text");
        // An Anthropic redacted_thinking block carries encrypted bytes and no
        // readable text. This wire has no field for it, and its opaque payload
        // must not be handed to another provider, so it is dropped rather than
        // replayed as an empty reasoning string.
        const reasoningParts = m.content.filter((p) => p.type === "reasoning" && !p.redacted);
        const toolUses = m.content.filter((p) => p.type === "tool_use");
        const entry: Record<string, unknown> = { role: "assistant", ...(m.name ? { name: m.name } : {}) };
        entry.content = textParts.length ? textParts.map((p) => p.text).join("") : null;
        if (reasoningParts.length) {
          // Every dialect spelling the DeepSeek-compatible world uses; each
          // upstream reads its own and ignores the rest. DeepSeek reads
          // `reasoning_content` (and its thinking-mode tool loop REQUIRES the
          // reasoning back), OpenRouter-style providers read `reasoning`, some
          // v4 gateways read `reasoning_text`.
          const reasoning = reasoningParts.map((p) => (p as { text: string }).text).join("");
          entry.reasoning_content = reasoning;
          entry.reasoning = reasoning;
          entry.reasoning_text = reasoning;
        }
        if (toolUses.length) {
          entry.tool_calls = toolUses.map((tu) => ({
            id: (tu as { id: string }).id,
            type: "function",
            function: { name: (tu as { name: string }).name, arguments: JSON.stringify((tu as { input: unknown }).input ?? {}) },
          }));
        }
        messages.push(entry);
        continue;
      }
      const toolResults = m.content.filter((p) => p.type === "tool_result");
      const others = m.content.filter((p) => p.type !== "tool_result");
      const resultImages: ContentPart[] = [];
      for (const tr of toolResults) {
        const r = tr as Extract<ContentPart, { type: "tool_result" }>;
        messages.push({ role: "tool", tool_call_id: r.toolUseId, content: textOf(r.content) });
        // The tool role is text-only on this wire; carry the result's images in
        // a follow-up user message instead of dropping them (screenshot loops).
        for (const part of r.content) if (part.type === "image") resultImages.push(part);
      }
      if (resultImages.length) {
        messages.push({ role: "user", content: openAiUserContent([{ type: "text", text: "(images returned by the tool results above)" }, ...resultImages]) });
      }
      if (others.length) messages.push({ role: "user", content: openAiUserContent(others), ...(m.name ? { name: m.name } : {}) });
    }

    const out: Record<string, unknown> = { model: target.upstreamModel, messages };
    if (this.tools) {
      const rendered = this.tools
        .filter((t) => !t.raw || t.raw.family === "openai_completion")
        .map((t) => (t.raw ? t.raw.value : { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters, ...(t.strict != null ? { strict: t.strict } : {}) } }));
      if (rendered.length) out.tools = rendered;
    }
    if (this.toolChoice) out.tool_choice = toolChoiceToOpenAI(this.toolChoice);
    const cap = target.providerMaxOutputTokens;
    const p = this.params;
    applyParams(out, p);
    if (this.stream) {
      out.stream = true;
      out.stream_options = { include_usage: true };
    }
    if (p.thinking) {
      // Reasoning is billed inside max_tokens on reasoning models, so the policy
      // sizes the ceiling to hold the reasoning and still leave the answer room.
      const tf = ThinkingPolicy.openai(p.thinking, p.maxTokens, cap);
      out.reasoning_effort = tf.effort;
      if (tf.maxTokens != null) out.max_tokens = tf.maxTokens;
    } else {
      const maxTokens = capMaxTokens(p.maxTokens, cap);
      if (maxTokens != null) out.max_tokens = maxTokens;
    }
    applyNonCanonical(out, p, this.family);
    return out;
  }

  /** Rebuild any canonical Request as an OpenAI Chat Completions request. */
  static construct(base: Request): OpenAICompletionRequest {
    return new OpenAICompletionRequest(base.data());
  }

  send(transport: Transport, target: SendTarget): Promise<SendResult> {
    return sendBuffered(this, transport, target);
  }

  relay(transport: Transport, target: SendTarget): Promise<RelayResult> {
    return relayStream(this, transport, target);
  }
}

// --- response subclass ---------------------------------------------------

export class OpenAICompletionResponse extends Response {
  readonly family = "openai_completion" as const;

  static parse(body: Record<string, unknown>): OpenAICompletionResponse {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const message = (choice.message ?? {}) as Record<string, unknown>;

    const content: ContentPart[] = [];
    const reasoning = String(message.reasoning ?? message.reasoning_content ?? message.reasoning_text ?? "");
    if (reasoning) content.push({ type: "reasoning", text: reasoning });
    if (typeof message.content === "string" && message.content) {
      content.push({ type: "text", text: message.content });
    } else if (Array.isArray(message.content)) {
      content.push(...coerceContentToParts(message.content));
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const fn = (call.function ?? {}) as Record<string, unknown>;
      content.push({ type: "tool_use", id: String(call.id ?? genId("call")), name: String(fn.name ?? ""), input: safeJsonParse(fn.arguments) });
    }

    if (typeof message.refusal === "string" && message.refusal) {
      content.push({ type: "text", text: message.refusal });
    }
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    const promptTokens = numOrUndef(usage.prompt_tokens) ?? 0;
    const completionTokens = numOrUndef(usage.completion_tokens) ?? 0;
    const completionDetails = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
    const cachedInputTokens = openAiCachedTokens(usage);
    const reasoningTokens = numOrUndef(completionDetails.reasoning_tokens);
    return new OpenAICompletionResponse({
      id: String(body.id ?? genId("chatcmpl")),
      model: String(body.model ?? ""),
      created: numOrUndef(body.created) ?? nowSeconds(),
      content,
      stopReason: finishReasonToStop(choice.finish_reason as string | null),
      usage: {
        promptTokens, completionTokens, totalTokens: numOrUndef(usage.total_tokens) ?? promptTokens + completionTokens,
        ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
        ...(reasoningTokens != null ? { reasoningTokens } : {}),
      },
    });
  }

  renderSelf(model: string, opts?: RenderOptions): Record<string, unknown> {
    const text = this.text();
    // Redacted blocks belong to the Anthropic wire only (see render()).
    const reasoningParts = this.content.filter((p) => p.type === "reasoning" && !p.redacted);
    const toolUses = this.content.filter((p) => p.type === "tool_use");
    const message: Record<string, unknown> = { role: "assistant", content: text || null };
    if (reasoningParts.length) {
      const reasoning = reasoningParts.map((p) => (p as { text: string }).text).join("");
      // BOTH dialect spellings by default, so a DeepSeek-convention client sees
      // the reasoning AND replays it — its absence is what broke the next turn
      // against an Anthropic-family upstream (4028: thinking must be passed
      // back), because the client had nothing to send.
      //
      // A service that names one spelling gets exactly that one and not the
      // other: a client strict about its own dialect can reject the extra key,
      // and one that reads both would count the thinking twice.
      const fmt = opts?.thinkingFormat;
      if (fmt !== "reasoning_content") message.reasoning = reasoning;
      if (fmt !== "reasoning") message.reasoning_content = reasoning;
    }
    if (toolUses.length) {
      message.tool_calls = toolUses.map((tu) => ({
        id: (tu as { id: string }).id,
        type: "function",
        function: { name: (tu as { name: string }).name, arguments: JSON.stringify((tu as { input: unknown }).input ?? {}) },
      }));
    }
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: stopToFinishReason(this.stopReason) }],
      usage: {
        prompt_tokens: this.usage.promptTokens, completion_tokens: this.usage.completionTokens, total_tokens: this.usage.totalTokens,
        ...(this.usage.cachedInputTokens != null ? { prompt_tokens_details: { cached_tokens: this.usage.cachedInputTokens } } : {}),
        ...(this.usage.reasoningTokens != null ? { completion_tokens_details: { reasoning_tokens: this.usage.reasoningTokens } } : {}),
      },
    };
  }

  static async *parseStream(readable: AsyncIterable<Buffer | string>): AsyncGenerator<StreamEvent> {
    let started = false;
    let terminated = false; // saw [DONE] or a finish_reason
    let stopReason: StopReason = null;
    let usage: ResponseData["usage"] | undefined;
    const seenTools = new Set<number>();

    for await (const frame of parseSSE(readable)) {
      if (frame.data === "[DONE]") {
        terminated = true;
        break;
      }
      const chunk = safeParseJson(frame.data);
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

      if (typeof delta.content === "string" && delta.content) yield { type: "text_delta", text: delta.content };

      const reasoning = delta.reasoning ?? delta.reasoning_content ?? delta.reasoning_text;
      if (typeof reasoning === "string" && reasoning) yield { type: "reasoning_delta", text: reasoning };

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const call = tc as Record<string, unknown>;
        const index = typeof call.index === "number" ? call.index : 0;
        const fn = (call.function ?? {}) as Record<string, unknown>;
        if (!seenTools.has(index) && (call.id || fn.name)) {
          seenTools.add(index);
          yield { type: "tool_start", index, id: String(call.id ?? genId("call")), name: String(fn.name ?? "") };
        }
        if (typeof fn.arguments === "string" && fn.arguments) yield { type: "tool_args_delta", index, delta: fn.arguments };
      }

      if (choice.finish_reason) {
        stopReason = finishReasonToStop(choice.finish_reason as string);
        terminated = true;
      }
      if (chunk.usage && typeof chunk.usage === "object") {
        const u = chunk.usage as Record<string, unknown>;
        const cd = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
        const cached = openAiCachedTokens(u);
        usage = {
          promptTokens: num(u.prompt_tokens),
          completionTokens: num(u.completion_tokens),
          totalTokens: num(u.total_tokens) || num(u.prompt_tokens) + num(u.completion_tokens),
          ...(cached != null ? { cachedInputTokens: cached } : {}),
          ...(numOrUndef(cd.reasoning_tokens) != null ? { reasoningTokens: num(cd.reasoning_tokens) } : {}),
        };
      }
    }

    // No terminal event (no [DONE], no finish_reason) means the upstream stream
    // was cut short. That includes a stream that never produced a single usable
    // chunk: a 200 carrying an unparsable or empty body is a failed attempt to
    // retry, not a successful empty answer.
    yield { type: "finish", stopReason, usage, incomplete: !terminated };
  }

  static async *serializeStream(events: AsyncGenerator<StreamEvent>, ctx: StreamContext): AsyncGenerator<string> {
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
        case "reasoning_delta": {
          // Both dialect spellings unless the service named one (see renderSelf).
          const delta: Record<string, unknown> = {};
          if (ctx.thinkingFormat !== "reasoning_content") delta.reasoning = ev.text;
          if (ctx.thinkingFormat !== "reasoning") delta.reasoning_content = ev.text;
          yield chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
          break;
        }
        case "tool_start":
          yield chunk({
            choices: [{ index: 0, delta: { tool_calls: [{ index: ev.index, id: ev.id, type: "function", function: { name: ev.name, arguments: "" } }] }, finish_reason: null }],
          });
          break;
        case "tool_args_delta":
          yield chunk({
            choices: [{ index: 0, delta: { tool_calls: [{ index: ev.index, function: { arguments: ev.delta } }] }, finish_reason: null }],
          });
          break;
        case "tool_stop":
          break;
        case "finish":
          // A truncated upstream must not be dressed up as a finished answer.
          // Emitting finish_reason + [DONE] here would leave the client unable
          // to tell a complete response from a cut-off one; relay() aborts the
          // connection instead, which every HTTP client surfaces as an error.
          if (ev.incomplete) return;
          yield chunk({ choices: [{ index: 0, delta: {}, finish_reason: stopToFinishReason(ev.stopReason) }] });
          if (ev.usage) {
            yield chunk({
              choices: [],
              usage: {
                prompt_tokens: ev.usage.promptTokens, completion_tokens: ev.usage.completionTokens, total_tokens: ev.usage.totalTokens,
                ...(ev.usage.cachedInputTokens != null ? { prompt_tokens_details: { cached_tokens: ev.usage.cachedInputTokens } } : {}),
                ...(ev.usage.reasoningTokens != null ? { completion_tokens_details: { reasoning_tokens: ev.usage.reasoningTokens } } : {}),
              },
            });
          }
          yield "data: [DONE]\n\n";
          break;
      }
    }
  }
}

registerFormat("openai_completion", { request: OpenAICompletionRequest, response: OpenAICompletionResponse });

export { finishReasonToStop, stopToFinishReason };
