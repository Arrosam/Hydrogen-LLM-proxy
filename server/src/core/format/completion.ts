import { chatReasoningDetails, parseChatReasoningDetails } from "./reasoningBridge";
import type { ReasoningPart, ToolUsePart } from "../ir/content";
import type { RenderTarget } from "../ir/request";
import { Response, type RenderOptions } from "../ir/response";
import {
  normalizeMessages,
  stripStaleReasoning,
  textOf,
  type ContentPart,
  type Message,
  type StopReason,
  type TextPart,
  type ToolChoice,
  SYSTEM_SEPARATOR,
  toolCallsOf,
} from "../ir/content";
import { isVerbosity, type GenerationParams, type ResponseFormat, type ThinkingLevel } from "../ir/params";
import { effortToThinking, ThinkingPolicy } from "../ir/thinking";
import type { ThinkingFormat } from "../ir/thinkingFormat";
import { SSE_DONE, parseSSE, parseSseJson, sseFrame, type ResponseData, type StreamContext, type StreamEvent } from "../ir/stream";
import { ID_PREFIX, genId, nowSeconds } from "../../util/ids";
import {
  applyNonCanonical,
  collectPassthrough,
  dataUrlOf,
  foreignFileIdError,
  hasCacheHint,
  imageUrlField,
  imageUrlOf,
  objectsIn,
  openAiCachedTokens,
  openAiJsonSchemaFields,
  OPENAI_ROLE as ROLE,
  TOOL_RESULT_IMAGES_NOTE,
  openAiUsageToWire,
  paramSetter,
  parseDataUrl,
  parseInlineFileData,
  parseOpenAiResponseFormat,
  parseOpenAiUsage,
  parseStop,
  stringContentParts,
  type OpenAiUsageKeys,
} from "./wire";
import { boolOrUndef, numOrUndef, parseToolArguments, strOrUndef } from "../ir/coerce";
import {
  OPENAI_TOOL_TYPE_FUNCTION as TOOL_TYPE_FUNCTION,
  parseOpenAiToolChoice,
  parseToolList,
  renderOpenAiToolChoice,
  renderToolList,
  type ToolWire,
} from "./tools";
import { FormatConversionError } from "./errors";
import { registerFormat } from "./registry";
import { WireRequest } from "./wireRequest";

// --- wire identifiers ----------------------------------------------------

/** `finish_reason` values. */
const FINISH_REASON = {
  STOP: "stop",
  LENGTH: "length",
  TOOL_CALLS: "tool_calls",
  FUNCTION_CALL: "function_call",
  CONTENT_FILTER: "content_filter",
} as const;

/** Content part types this wire both reads and writes. */
const PART = {
  TEXT: "text",
  IMAGE_URL: "image_url",
  FILE: "file",
} as const;

/** Where this wire's `usage` object keeps its counters. */
const USAGE_KEYS: OpenAiUsageKeys = {
  prompt: "prompt_tokens",
  completion: "completion_tokens",
  promptDetails: "prompt_tokens_details",
  completionDetails: "completion_tokens_details",
};

/** The provider name a conversion refusal reports. */
const PROVIDER_LABEL = "an OpenAI Chat Completions";

/** The OpenAI wire allows at most this many stop sequences. */
const OPENAI_MAX_STOP_SEQUENCES = 4;

/**
 * Models that take `max_completion_tokens` and reject `max_tokens`. The id is
 * matched at the start or after a vendor prefix (`openai/gpt-5`,
 * `azure/openai/o3-mini`), which is how gateways and aggregators spell it.
 */
const MAX_COMPLETION_TOKENS_MODEL_RE = /(?:^|\/)(o[1-9](?:-|$)|gpt-5(?:[.-]|$))/i;

// --- stop reason mapping -------------------------------------------------

function finishReasonToStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case FINISH_REASON.STOP:
      return "stop";
    case FINISH_REASON.LENGTH:
      return "length";
    case FINISH_REASON.TOOL_CALLS:
    case FINISH_REASON.FUNCTION_CALL:
      return "tool_use";
    case FINISH_REASON.CONTENT_FILTER:
      return "content_filter";
    default:
      return reason ? "stop" : null;
  }
}

function stopToFinishReason(reason: StopReason): string {
  switch (reason) {
    case "length":
      return FINISH_REASON.LENGTH;
    case "tool_use":
      return FINISH_REASON.TOOL_CALLS;
    case "content_filter":
      return FINISH_REASON.CONTENT_FILTER;
    default:
      return FINISH_REASON.STOP;
  }
}

/**
 * The first reasoning field on a body that actually carries text.
 *
 * Every server in this family spells the trace its own way -- `reasoning`
 * (OpenRouter, Ollama's OpenAI-compatible endpoint), `reasoning_content`
 * (DeepSeek, vLLM, llama.cpp), `reasoning_text`, or `thinking` (Ollama's own
 * field name) -- and some send more than one. Picking the first field that is
 * merely PRESENT lets an empty `reasoning: ""` mask a populated
 * `reasoning_content`, which is thinking silently thrown away; DSH reads these
 * fields the same way, first non-empty, and for the same reason.
 */
const REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text", "thinking"] as const;

function firstReasoningField(source: Record<string, unknown>): string {
  for (const field of REASONING_FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

// --- content coercion ----------------------------------------------------

function coerceContentToParts(content: unknown): ContentPart[] {
  const text = stringContentParts(content);
  if (text) return text;
  const parts: ContentPart[] = [];
  for (const item of objectsIn(content)) {
    const t = item.type;
    if (t === PART.TEXT || t === "input_text" || t === "output_text") {
      parts.push({ type: "text", text: String(item.text ?? "") });
    } else if (t === PART.IMAGE_URL) {
      // Unlike the Responses parser, an image with no URL is kept, not skipped.
      parts.push({ type: "image", source: parseDataUrl(imageUrlField(item.image_url)) });
    } else if (t === PART.FILE) {
      const f = (item.file ?? {}) as Record<string, unknown>;
      const name = f.filename != null ? String(f.filename) : undefined;
      // Coerced, not type-checked: a non-string `file_data` is read as its string form.
      const data = String(f.file_data ?? "");
      const fileId = strOrUndef(f.file_id);
      if (data) {
        parts.push({ type: "file", source: parseInlineFileData(data), name });
      } else if (fileId) {
        // Kept rather than dropped: a same-family replay restores the reference
        // exactly, and any other family now rejects it loudly instead of
        // quietly sending a request with the attachment missing.
        parts.push({ type: "file", source: { kind: "file_id", id: fileId, family: "openai_completion" }, name });
      }
    } else if (t === "input_audio") {
      // No canonical audio type: keep verbatim for same-family replay.
      parts.push({ type: "opaque", family: "openai_completion", value: item });
    } else if (t === "thinking" || t === "reasoning" || t === "reasoning_text") {
      // Reasoning delivered as a content PART rather than a `reasoning` field:
      // gateways that pass an Anthropic-shaped block through an OpenAI-shaped
      // body do this, and so does a local server whose content is typed `any`.
      // Dropping the part is how a response arrives with thinking and no answer.
      const text = String(item.text ?? item.thinking ?? "");
      if (text) parts.push({ type: "reasoning", text });
    }
  }
  return parts;
}

/**
 * The events for content that arrived as PARTS rather than a plain string.
 *
 * Streaming deltas carry `content` as a string almost everywhere, but the field
 * is `any` in several servers' wire types and parts do show up mid-stream. A
 * reasoning part among them is still reasoning, so it is classified here rather
 * than thrown away with the rest of the array.
 */
function* contentPartEvents(parts: ContentPart[]): Generator<StreamEvent> {
  for (const p of parts) {
    if (p.type === "text" && p.text) yield { type: "text_delta", text: p.text };
    else if (p.type === "reasoning" && p.text) yield { type: "reasoning_delta", text: p.text };
  }
}

function imagePartToOpenAI(source: (ContentPart & { type: "image" })["source"]): unknown {
  return { type: PART.IMAGE_URL, image_url: { url: imageUrlOf(source) } };
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
      return { type: PART.FILE, file: { ...named, file_data: dataUrlOf(p.source.mediaType, p.source.data) } };
    case "file_id":
      if (p.source.family !== "openai_completion") throw foreignFileIdError(p.source, PROVIDER_LABEL);
      return { type: PART.FILE, file: { ...named, file_id: p.source.id } };
    case "url":
      throw new FormatConversionError(
        `cannot send a URL file attachment (${p.source.url}) to ${PROVIDER_LABEL} provider: ` +
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
    else if (p.type === "text") out.push({ type: PART.TEXT, text: p.text });
  }
  return out;
}

// --- tools ---------------------------------------------------------------

/**
 * A function tool nests its fields under `function`. An entry without a named
 * function is a built-in / custom tool type this format cannot model: kept
 * verbatim for same-family replay instead of silently dropped, under its
 * `type` (this wire never reads a top-level `name` for it).
 */
const TOOL_WIRE: ToolWire = {
  family: "openai_completion",
  functionFields: (entry) => {
    const fn = (entry.function ?? {}) as Record<string, unknown>;
    return fn.name ? fn : undefined;
  },
  schemaKey: "parameters",
  extras: (fn) => (typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
  nativeName: (entry) => (entry.type ? String(entry.type) : undefined),
  render: (t) => ({ type: TOOL_TYPE_FUNCTION, function: { name: t.name, description: t.description, parameters: t.parameters, ...(t.strict != null ? { strict: t.strict } : {}) } }),
};

/** The object form nests the name under `function`; its `type` is not checked. */
function parseToolChoice(raw: unknown): ToolChoice | undefined {
  return parseOpenAiToolChoice(raw, (c) => ((c.function ?? {}) as Record<string, unknown>).name);
}

function toolChoiceToOpenAI(choice: ToolChoice): unknown {
  return renderOpenAiToolChoice(choice, (name) => ({ type: TOOL_TYPE_FUNCTION, function: { name } }));
}

/** The tool calls of an assistant message, buffered (`message.tool_calls`). */
function parseToolCalls(raw: unknown): ToolUsePart[] {
  const calls: ToolUsePart[] = [];
  for (const call of objectsIn(raw)) {
    const fn = (call.function ?? {}) as Record<string, unknown>;
    calls.push({ type: "tool_use", id: String(call.id ?? genId(ID_PREFIX.CALL)), name: String(fn.name ?? ""), input: parseToolArguments(fn.arguments) });
  }
  return calls;
}

/**
 * A streamed call not yet announced downstream (`delta.tool_calls`): the
 * argument text that preceded its start and, once its id arrived without a
 * name, the id and the name pieces gathered since.
 */
interface HeldToolCall {
  id?: string;
  name: string;
  args: string;
}

/** Whether an id or a name has arrived for the call, i.e. it is more than stray argument text. */
const isIdentified = (held: HeldToolCall): boolean => held.id !== undefined || held.name !== "";

/** The `tool_calls` of an assistant message, or undefined when it made none. */
function renderToolCalls(content: ContentPart[]): unknown[] | undefined {
  const calls = toolCallsOf(content).map((tc) => ({ id: tc.id, type: TOOL_TYPE_FUNCTION, function: { name: tc.name, arguments: tc.args } }));
  return calls.length ? calls : undefined;
}

/** The readable reasoning of a message. An Anthropic redacted_thinking block carries encrypted bytes and no
 * readable text; this wire has no field for it, and its opaque payload must not be handed to another provider,
 * so it is left out rather than replayed as an empty reasoning string. Undefined when there is no such part. */
function visibleReasoning(content: ContentPart[]): string | undefined {
  const parts = content.filter((p): p is ReasoningPart => p.type === "reasoning" && !p.redacted);
  return parts.length ? parts.map((p) => p.text).join("") : undefined;
}

/**
 * Reasoning text under the spelling(s) a CLIENT is sent.
 *
 * BOTH dialect spellings by default, so a DeepSeek-convention client sees the
 * reasoning AND replays it — its absence is what broke the next turn against
 * an Anthropic-family upstream (4028: thinking must be passed back), because
 * the client had nothing to send.
 *
 * A service that names one spelling gets exactly that one and not the other: a
 * client strict about its own dialect can reject the extra key, and one that
 * reads both would count the thinking twice.
 */
function clientReasoningFields(text: string, format: ThinkingFormat | undefined): Record<string, unknown> {
  return {
    ...(format !== "reasoning_content" ? { reasoning: text } : {}),
    ...(format !== "reasoning" ? { reasoning_content: text } : {}),
  };
}

// --- response_format -----------------------------------------------------

/** The json_schema fields sit one level down, under `json_schema`. */
function parseResponseFormat(raw: unknown): ResponseFormat | undefined {
  return parseOpenAiResponseFormat(raw, (format) => (format.json_schema ?? {}) as Record<string, unknown>);
}

function responseFormatToOpenAI(rf: ResponseFormat): unknown {
  if (rf.type === "json_schema") return { type: rf.type, json_schema: openAiJsonSchemaFields(rf) };
  return { type: rf.type };
}

// --- thinking ------------------------------------------------------------

/**
 * An effort this proxy does not model sets no thinking level at all: the
 * provider's default applies, and `max_completion_tokens` stays what the
 * client said it is -- the output ceiling, never a thinking budget.
 */
function parseThinking(body: Record<string, unknown>): ThinkingLevel | undefined {
  return effortToThinking(body.reasoning_effort);
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

const RESPONSE_FORMAT_KEY = "response_format";
/** {@link RESERVED} for a request whose `response_format` this proxy does not model. */
const RESERVED_EXCEPT_RESPONSE_FORMAT = new Set([...RESERVED].filter((key) => key !== RESPONSE_FORMAT_KEY));

function parseParams(body: Record<string, unknown>): GenerationParams {
  const params: GenerationParams = {};
  const set = paramSetter(params);
  set("temperature", numOrUndef(body.temperature));
  set("topP", numOrUndef(body.top_p));
  set("topK", numOrUndef(body.top_k));
  set("minP", numOrUndef(body.min_p));
  set("maxTokens", numOrUndef(body.max_completion_tokens) ?? numOrUndef(body.max_tokens));
  if (body.max_completion_tokens != null) params.completionTokenKey = "max_completion_tokens";
  else if (body.max_tokens != null) params.completionTokenKey = "max_tokens";
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
  if (isVerbosity(body.verbosity)) params.verbosity = body.verbosity;
  set("thinking", parseThinking(body));
  // OpenAI's caching is automatic; the presence of its tuning params is the
  // client saying "this conversation repeats" — enough to auto-plant an
  // Anthropic breakpoint on a cross-family hop.
  if (hasCacheHint(body)) params.cacheHint = true;
  // A response_format of a type this proxy does not model (a server's own
  // `grammar` / `regex` / ...) has no canonical form, so it travels as the
  // client's other unrecognised params do: verbatim, to its own family only.
  const unmodelledFormat = body.response_format != null && params.responseFormat === undefined;
  set("passthrough", collectPassthrough(body, unmodelledFormat ? RESERVED_EXCEPT_RESPONSE_FORMAT : RESERVED, "openai_completion"));
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
  if (p.stop && p.stop.length) out.stop = p.stop.slice(0, OPENAI_MAX_STOP_SEQUENCES); // OpenAI wire allows at most 4
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

export class OpenAICompletionRequest extends WireRequest {
  readonly family = "openai_completion" as const;

  static parse(body: Record<string, unknown>): OpenAICompletionRequest {
    const systemChunks: string[] = [];
    const messages: Message[] = [];
    /** A system or tool message is text-only here: a string as sent, or the text parts of an array. */
    const plainText = (content: unknown): string =>
      typeof content === "string" ? content : textOf(coerceContentToParts(content));

    for (const msg of objectsIn(body.messages)) {
      const role = String(msg.role);

      if (role === ROLE.SYSTEM || role === ROLE.DEVELOPER) {
        const text = plainText(msg.content);
        if (text) systemChunks.push(text);
        continue;
      }

      if (role === ROLE.TOOL) {
        messages.push({
          role: "user",
          content: [{ type: "tool_result", toolUseId: String(msg.tool_call_id ?? ""), content: [{ type: "text", text: plainText(msg.content) }] }],
        });
        continue;
      }

      const name = typeof msg.name === "string" && msg.name ? msg.name : undefined;
      if (role === ROLE.ASSISTANT) {
        const content = coerceContentToParts(msg.content);
        // Providers disagree on the field name: DeepSeek says reasoning_content,
        // OpenRouter-style gateways say reasoning, some v4 gateways say
        // reasoning_text. Accept them all, by the rule responses are read with:
        // the first one that carries text.
        const reasoning = firstReasoningField(msg);
        const replay = parseChatReasoningDetails(msg.reasoning_details);
        if (replay.length) content.unshift(...replay);
        else if (reasoning) content.push({ type: "reasoning", text: reasoning });
        content.push(...parseToolCalls(msg.tool_calls));
        messages.push({ role: "assistant", content, ...(name ? { name } : {}) });
        continue;
      }

      messages.push({ role: "user", content: coerceContentToParts(msg.content), ...(name ? { name } : {}) });
    }

    return new OpenAICompletionRequest({
      requestedService: String(body.model ?? ""),
      system: systemChunks.length ? systemChunks.join(SYSTEM_SEPARATOR) : undefined,
      // Reasoning is NOT stripped here: what a target may be sent back is the
      // egress family's rule, applied in render().
      messages: normalizeMessages(messages),
      tools: parseToolList(body.tools, TOOL_WIRE),
      toolChoice: parseToolChoice(body.tool_choice),
      params: parseParams(body),
      stream: Boolean(body.stream),
    });
  }

  render(target: RenderTarget): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    if (this.system) messages.push({ role: ROLE.SYSTEM, content: this.system });

    // Prior turns' reasoning is dropped on the way out: DeepSeek's
    // OpenAI-compatible endpoint rejects reasoning_content sent back to it, and
    // the rest of the family ignores it.
    for (const m of stripStaleReasoning(this.messages)) {
      if (m.role === "assistant") {
        const textParts = m.content.filter((p): p is TextPart => p.type === "text");
        const reasoning = visibleReasoning(m.content);
        const toolCalls = renderToolCalls(m.content);
        const entry: Record<string, unknown> = { role: ROLE.ASSISTANT, ...(m.name ? { name: m.name } : {}) };
        entry.content = textParts.length ? textParts.map((p) => p.text).join("") : null;
        if (reasoning !== undefined) {
          // Every dialect spelling the DeepSeek-compatible world uses; each
          // upstream reads its own and ignores the rest. DeepSeek reads
          // `reasoning_content` (and its thinking-mode tool loop REQUIRES the
          // reasoning back), OpenRouter-style providers read `reasoning`, some
          // v4 gateways read `reasoning_text`.
          entry.reasoning_content = reasoning;
          entry.reasoning = reasoning;
          entry.reasoning_text = reasoning;
        }
        if (toolCalls) entry.tool_calls = toolCalls;
        messages.push(entry);
        continue;
      }
      const toolResults = m.content.filter((p) => p.type === "tool_result");
      const others = m.content.filter((p) => p.type !== "tool_result");
      const resultImages: ContentPart[] = [];
      for (const tr of toolResults) {
        const r = tr as Extract<ContentPart, { type: "tool_result" }>;
        messages.push({ role: ROLE.TOOL, tool_call_id: r.toolUseId, content: textOf(r.content) });
        // The tool role is text-only on this wire; carry the result's images in
        // a follow-up user message instead of dropping them (screenshot loops).
        for (const part of r.content) if (part.type === "image") resultImages.push(part);
      }
      if (resultImages.length) {
        messages.push({ role: ROLE.USER, content: openAiUserContent([{ type: "text", text: TOOL_RESULT_IMAGES_NOTE }, ...resultImages]) });
      }
      if (others.length) messages.push({ role: ROLE.USER, content: openAiUserContent(others), ...(m.name ? { name: m.name } : {}) });
    }

    const out: Record<string, unknown> = { model: target.upstreamModel, messages };
    const tools = renderToolList(this.tools, TOOL_WIRE);
    if (tools) out.tools = tools;
    if (this.toolChoice) out.tool_choice = toolChoiceToOpenAI(this.toolChoice);
    const cap = target.providerMaxOutputTokens;
    const p = this.params;
    applyParams(out, p);
    const ceilingKey = MAX_COMPLETION_TOKENS_MODEL_RE.test(target.upstreamModel)
      ? "max_completion_tokens" : p.completionTokenKey ?? "max_tokens";
    if (this.stream) {
      out.stream = true;
      out.stream_options = { include_usage: true };
    }
    // Reasoning is billed inside max_tokens on reasoning models, so with a
    // thinking level set the policy sizes the ceiling to hold the reasoning and
    // still leave the answer room.
    const ceiling = ThinkingPolicy.openai(p.thinking, p.maxTokens, cap);
    if (ceiling.effort != null) out.reasoning_effort = ceiling.effort;
    if (ceiling.maxTokens != null) out[ceilingKey] = ceiling.maxTokens;
    applyNonCanonical(out, p, this.family);
    return out;
  }
}

// --- response subclass ---------------------------------------------------

export class OpenAICompletionResponse extends Response {
  readonly family = "openai_completion" as const;

  /** A completion always carries at least one choice. */
  static isEnvelope(body: Record<string, unknown>): boolean {
    return Array.isArray(body.choices) && body.choices.length > 0;
  }

  static parse(body: Record<string, unknown>): OpenAICompletionResponse {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const message = (choice.message ?? {}) as Record<string, unknown>;

    const content: ContentPart[] = [];
    const reasoning = firstReasoningField(message);
    const replay = parseChatReasoningDetails(message.reasoning_details);
    if (replay.length) content.push(...replay);
    else if (reasoning) content.push({ type: "reasoning", text: reasoning });
    if (typeof message.content === "string" && message.content) {
      content.push({ type: "text", text: message.content });
    } else if (Array.isArray(message.content)) {
      content.push(...coerceContentToParts(message.content));
    }
    content.push(...parseToolCalls(message.tool_calls));

    if (typeof message.refusal === "string" && message.refusal) {
      content.push({ type: "text", text: message.refusal });
    }
    return new OpenAICompletionResponse({
      id: String(body.id ?? genId(ID_PREFIX.CHAT_COMPLETION)),
      model: String(body.model ?? ""),
      created: numOrUndef(body.created) ?? nowSeconds(),
      content,
      stopReason: finishReasonToStop(choice.finish_reason as string | null),
      usage: parseOpenAiUsage((body.usage ?? {}) as Record<string, unknown>, USAGE_KEYS),
    });
  }

  renderSelf(model: string, opts?: RenderOptions): Record<string, unknown> {
    const text = this.text();
    // Visible reasoning is text; opaque blocks travel in client replay metadata.
    const reasoning = visibleReasoning(this.content);
    const toolCalls = renderToolCalls(this.content);
    const message: Record<string, unknown> = { role: ROLE.ASSISTANT, content: text || null };
    const signed = this.content.filter((p): p is ReasoningPart => p.type === "reasoning");
    if (signed.some(p => p.signature || p.redacted)) message.reasoning_details = chatReasoningDetails(signed);
    if (reasoning !== undefined) Object.assign(message, clientReasoningFields(reasoning, opts?.thinkingFormat));
    if (toolCalls) message.tool_calls = toolCalls;
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: stopToFinishReason(this.stopReason) }],
      usage: openAiUsageToWire(this.usage, USAGE_KEYS),
    };
  }

  static async *parseStream(readable: AsyncIterable<Buffer | string>): AsyncGenerator<StreamEvent> {
    let started = false;
    let terminated = false; // saw [DONE] or a finish_reason
    let stopReason: StopReason = null;
    let usage: ResponseData["usage"] | undefined;
    let reasoningTextSeen = false;
    const seenTools = new Set<number>();
    /** What arrived for a call before it could be announced, by call index. */
    const heldTools = new Map<number, HeldToolCall>();
    /** Announces, in call order, every held call that was identified: nothing more can extend its name. */
    const releaseHeldTools = function* (): Generator<StreamEvent> {
      for (const [index, held] of [...heldTools].sort(([a], [b]) => a - b)) {
        if (!isIdentified(held)) continue;
        seenTools.add(index);
        yield { type: "tool_start", index, id: held.id ?? genId(ID_PREFIX.CALL), name: held.name };
        if (held.args) yield { type: "tool_args_delta", index, delta: held.args };
      }
      heldTools.clear();
    };

    for await (const frame of parseSSE(readable)) {
      if (frame.data === SSE_DONE) {
        terminated = true;
        break;
      }
      const chunk = parseSseJson(frame.data);
      if (!chunk) continue;

      if (!started) {
        started = true;
        yield {
          type: "start",
          id: String(chunk.id ?? genId(ID_PREFIX.CHAT_COMPLETION)),
          model: String(chunk.model ?? ""),
          created: typeof chunk.created === "number" ? chunk.created : nowSeconds(),
        };
      }

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = (choices[0] ?? {}) as Record<string, unknown>;
      const delta = (choice.delta ?? {}) as Record<string, unknown>;

      // `content` is a string on every mainstream server, but it is typed `any`
      // in several wire definitions and SOME deltas do carry parts. Reading only
      // the string form silently dropped those deltas, which reads downstream as
      // a model that answered with nothing.
      if (typeof delta.content === "string") {
        if (delta.content) yield { type: "text_delta", text: delta.content };
      } else if (Array.isArray(delta.content)) {
        yield* contentPartEvents(coerceContentToParts(delta.content));
      }
      if (typeof delta.refusal === "string" && delta.refusal) yield { type: "text_delta", text: delta.refusal };

      const reasoning = firstReasoningField(delta);
      if (reasoning) {
        reasoningTextSeen = true;
        yield { type: "reasoning_delta", text: reasoning };
      }
      for (const p of parseChatReasoningDetails(delta.reasoning_details)) {
        if (!reasoningTextSeen) {
          yield { type: "reasoning_start", origin: p.origin, id: p.itemId, redacted: p.redacted, signature: p.signature };
          if (p.text) yield { type: "reasoning_delta", text: p.text };
        }
        yield { type: "reasoning_stop", origin: p.origin, id: p.itemId, redacted: p.redacted, signature: p.signature };
        reasoningTextSeen = false;
      }

      for (const call of objectsIn(delta.tool_calls)) {
        const index = typeof call.index === "number" ? call.index : 0;
        const fn = (call.function ?? {}) as Record<string, unknown>;
        const args = typeof fn.arguments === "string" ? fn.arguments : "";
        if (!seenTools.has(index)) {
          const held = heldTools.get(index) ?? { name: "", args: "" };
          if (!fn.name || [...heldTools.values()].some(isIdentified)) {
            // Some servers send argument text ahead of the chunk that carries
            // the call's id and name. A delta for a call that has not started
            // belongs to nothing downstream, so it is held until the start.
            // Others send the id alone and the name later, possibly in pieces
            // with argument text in between. A start cannot be amended (on the
            // Anthropic wire the name exists only there), and no chunk marks a
            // name as finished, so such a call stays held until the stream
            // ends — and so does every call that begins while one is held,
            // or it would overtake the held call downstream.
            if (call.id) held.id ??= String(call.id);
            if (fn.name) held.name += String(fn.name);
            held.args += args;
            heldTools.set(index, held);
            continue;
          }
          seenTools.add(index);
          yield { type: "tool_start", index, id: String(call.id ?? genId(ID_PREFIX.CALL)), name: String(fn.name) };
          if (held.args) yield { type: "tool_args_delta", index, delta: held.args };
          heldTools.delete(index);
        }
        if (args) yield { type: "tool_args_delta", index, delta: args };
      }

      if (choice.finish_reason) {
        yield* releaseHeldTools();
        stopReason = finishReasonToStop(choice.finish_reason as string);
        terminated = true;
      }
      if (chunk.usage && typeof chunk.usage === "object") {
        const u = chunk.usage as Record<string, unknown>;
        const cd = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
        const cached = openAiCachedTokens(u);
        const prompt = numOrUndef(u.prompt_tokens);
        const completion = numOrUndef(u.completion_tokens);
        const total = numOrUndef(u.total_tokens);
        const reasoning = numOrUndef(cd.reasoning_tokens);
        if (prompt == null && completion == null && total == null && cached == null && reasoning == null) continue;
        usage = {
          ...usage,
          promptTokens: prompt ?? usage?.promptTokens ?? 0,
          completionTokens: completion ?? usage?.completionTokens ?? 0,
          totalTokens: total ?? (prompt == null && completion == null && usage ? usage.totalTokens :
            (prompt ?? usage?.promptTokens ?? 0) + (completion ?? usage?.completionTokens ?? 0)),
          ...(cached != null ? { cachedInputTokens: cached } : {}),
          ...(reasoning != null ? { reasoningTokens: reasoning } : {}),
        };
        yield { type: "usage", usage };
      }
    }

    yield* releaseHeldTools();

    // No terminal event (no [DONE], no finish_reason) means the upstream stream
    // was cut short. That includes a stream that never produced a single usable
    // chunk: a 200 carrying an unparsable or empty body is a failed attempt to
    // retry, not a successful empty answer.
    yield { type: "finish", stopReason, usage, incomplete: !terminated };
  }

  static async *serializeStream(events: AsyncGenerator<StreamEvent>, ctx: StreamContext): AsyncGenerator<string> {
    let id = genId(ID_PREFIX.CHAT_COMPLETION);
    let created = nowSeconds();
    const model = ctx.model;
    let reasoningPart: ReasoningPart | undefined;
    let reasoningIndex = 0;

    const chunk = (payload: Record<string, unknown>): string =>
      sseFrame(JSON.stringify({ id, object: "chat.completion.chunk", created, model, ...payload }));
    /** A chunk carrying one delta on the single choice this proxy streams. */
    const deltaChunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
      chunk({ choices: [{ index: 0, delta, finish_reason: finishReason }] });

    for await (const ev of events) {
      switch (ev.type) {
        case "start":
          id = ev.id || id;
          created = ev.created || created;
          yield deltaChunk({ role: ROLE.ASSISTANT });
          break;
        case "text_delta":
          yield deltaChunk({ content: ev.text });
          break;
        case "reasoning_start":
          reasoningPart = { type: "reasoning", text: "", origin: ev.origin, itemId: ev.id, signature: ev.signature, redacted: ev.redacted };
          break;
        case "reasoning_stop": {
          const p: ReasoningPart = { ...reasoningPart, type: "reasoning", text: reasoningPart?.text ?? "", origin: ev.origin ?? reasoningPart?.origin, signature: ev.signature ?? reasoningPart?.signature, itemId: ev.id ?? reasoningPart?.itemId, redacted: ev.redacted ?? reasoningPart?.redacted };
          if (p.text || p.signature || p.redacted) {
            const detail = chatReasoningDetails([p])[0] as Record<string, unknown>;
            yield deltaChunk({ reasoning_details: [{ ...detail, index: reasoningIndex++ }] });
          }
          reasoningPart = undefined;
          break;
        }
        case "reasoning_delta": {
          if (reasoningPart) reasoningPart.text += ev.text;
          yield deltaChunk(clientReasoningFields(ev.text, ctx.thinkingFormat));
          break;
        }
        case "tool_start":
          yield deltaChunk({ tool_calls: [{ index: ev.index, id: ev.id, type: TOOL_TYPE_FUNCTION, function: { name: ev.name, arguments: "" } }] });
          break;
        case "tool_args_delta":
          yield deltaChunk({ tool_calls: [{ index: ev.index, function: { arguments: ev.delta } }] });
          break;
        case "tool_stop":
          break;
        case "finish":
          // A truncated upstream must not be dressed up as a finished answer.
          // Emitting finish_reason + [DONE] here would leave the client unable
          // to tell a complete response from a cut-off one; relay() aborts the
          // connection instead, which every HTTP client surfaces as an error.
          if (ev.incomplete || ev.error) return;
          yield deltaChunk({}, stopToFinishReason(ev.stopReason));
          if (ev.usage) yield chunk({ choices: [], usage: openAiUsageToWire(ev.usage, USAGE_KEYS) });
          yield sseFrame(SSE_DONE);
          break;
      }
    }
  }
}

registerFormat("openai_completion", { request: OpenAICompletionRequest, response: OpenAICompletionResponse });
