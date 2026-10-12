import { clientSignature, decodeReasoning, isOwnOrigin, nativeSignature } from "./reasoningBridge";
import type { RenderTarget } from "../ir/request";
import { Response, type RenderOptions } from "../ir/response";
import {
  normalizeMessages,
  orderReasoningFirst,
  type ContentPart,
  type FileSource,
  type ImagePart,
  type Message,
  type StopReason,
  type TextPart,
  type ToolChoice,
  type ToolUsePart,
  DEFAULT_FILE_MEDIA_TYPE,
  DEFAULT_IMAGE_MEDIA_TYPE,
  SYSTEM_SEPARATOR,
} from "../ir/content";
import { isEffortLevel, type GenerationParams, type ThinkingLevel } from "../ir/params";
import { ThinkingPolicy } from "../ir/thinking";
import { parseSSE, parseSseJson, sseFrame, type StreamContext, type StreamEvent } from "../ir/stream";
import { ID_PREFIX, genId, nowSeconds } from "../../util/ids";
import { DEFAULT_PROMPT_CACHE_TTL_MINUTES } from "../../config/defaults";
import { applyNonCanonical, collectPassthrough, foreignFileIdError, objectsIn, paramSetter, stringContentParts } from "./wire";
import { num, numOrUndef, parseToolArguments } from "../ir/coerce";
import { parseToolList, renderToolList, type ToolWire } from "./tools";
import { FormatConversionError } from "./errors";
import { cacheCounters, foldCacheIntoPrompt, uncachedPromptTokens, type Usage } from "../ir/usage";
import { registerFormat } from "./registry";
import { WireRequest } from "./wireRequest";

// --- wire identifiers ----------------------------------------------------

/** SSE event types of a Messages stream. */
const EVENT = {
  MESSAGE_START: "message_start",
  CONTENT_BLOCK_START: "content_block_start",
  CONTENT_BLOCK_DELTA: "content_block_delta",
  CONTENT_BLOCK_STOP: "content_block_stop",
  MESSAGE_DELTA: "message_delta",
  MESSAGE_STOP: "message_stop",
} as const;

/** `delta.type` values of a content_block_delta. */
const DELTA = {
  TEXT: "text_delta",
  THINKING: "thinking_delta",
  SIGNATURE: "signature_delta",
  INPUT_JSON: "input_json_delta",
} as const;

/** Content block types. */
const BLOCK = {
  TEXT: "text",
  IMAGE: "image",
  DOCUMENT: "document",
  THINKING: "thinking",
  REDACTED_THINKING: "redacted_thinking",
  TOOL_USE: "tool_use",
  TOOL_RESULT: "tool_result",
  SERVER_TOOL_USE: "server_tool_use",
  SERVER_TOOL_RESULT: "server_tool_result",
  WEB_SEARCH_RESULT: "web_search_result",
  WEB_SEARCH_TOOL_RESULT: "web_search_tool_result",
} as const;

/** `source.type` values of an image / document block. */
const SOURCE = {
  URL: "url",
  BASE64: "base64",
  TEXT: "text",
  FILE: "file",
} as const;

/** `stop_reason` values. */
const STOP_REASON = {
  END_TURN: "end_turn",
  STOP_SEQUENCE: "stop_sequence",
  MAX_TOKENS: "max_tokens",
  TOOL_USE: "tool_use",
  REFUSAL: "refusal",
  PAUSE_TURN: "pause_turn",
} as const;

/** `tool_choice.type` values. */
const TOOL_CHOICE = {
  AUTO: "auto",
  ANY: "any",
  NONE: "none",
  TOOL: "tool",
} as const;

const MESSAGE_OBJECT = "message";
const ROLE_ASSISTANT = "assistant";
/** `caller.type` of a call the provider made itself. */
const CALLER_DIRECT = "direct";

/** Every provider-executed result block type ends in this (web_search_tool_result, ...). */
const SERVER_TOOL_RESULT_SUFFIX = "_tool_result";
/** Parts of a result block type its error object's type is derived from. */
const SERVER_TOOL_INFIX = "_tool_";
const RESULT_SUFFIX_RE = /_result$/;
const ERROR_TYPE_SUFFIX = "_error";
/** Name given to a server-tool result whose call was never seen. */
const UNKNOWN_SERVER_TOOL_NAME = "server_tool";

/** cache_control: the wire accepts only the 5m default and a 1h TTL. */
const CACHE_CONTROL_EPHEMERAL = "ephemeral";
const SHORT_CACHE_TTL_MINUTES = 5;
const LONG_CACHE_TTL = "1h";

/** Anthropic's sampling range for temperature and top_p. */
const SAMPLING_MIN = 0;
const SAMPLING_MAX = 1;
/** Anthropic's sampling ranges are narrower than OpenAI's (temperature 0..1 vs
 * 0..2); clamp instead of letting the upstream 400 the whole request. */
const clampSampling = (value: number): number => Math.min(Math.max(value, SAMPLING_MIN), SAMPLING_MAX);

/** The provider name a conversion refusal reports. */
const PROVIDER_LABEL = "an Anthropic";

// --- stop reason mapping -------------------------------------------------

function stopReasonToStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case STOP_REASON.END_TURN:
    case STOP_REASON.STOP_SEQUENCE:
      return "stop";
    case STOP_REASON.MAX_TOKENS:
      return "length";
    case STOP_REASON.TOOL_USE:
      return "tool_use";
    case STOP_REASON.REFUSAL:
      return "content_filter";
    case STOP_REASON.PAUSE_TURN:
      return "pause_turn";
    default:
      return reason ? "stop" : null;
  }
}

function stopToAnthropic(reason: StopReason): string {
  switch (reason) {
    case "length":
      return STOP_REASON.MAX_TOKENS;
    case "tool_use":
      return STOP_REASON.TOOL_USE;
    case "content_filter":
      return STOP_REASON.REFUSAL;
    case "pause_turn":
      return STOP_REASON.PAUSE_TURN;
    default:
      return STOP_REASON.END_TURN;
  }
}

// --- block <-> part coercion ---------------------------------------------

function systemToText(system: unknown): string | undefined {
  if (system == null) return undefined;
  if (typeof system === "string") return system || undefined;
  if (Array.isArray(system)) {
    const text = system
      .filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === BLOCK.TEXT)
      .map((b) => String((b as Record<string, unknown>).text ?? ""))
      .join(SYSTEM_SEPARATOR);
    return text || undefined;
  }
  return undefined;
}

function parseImageSource(source: unknown): ImagePart["source"] {
  const s = (source ?? {}) as Record<string, unknown>;
  if (s.type === SOURCE.URL) return { kind: "url", url: String(s.url ?? "") };
  return { kind: "base64", mediaType: String(s.media_type ?? DEFAULT_IMAGE_MEDIA_TYPE), data: String(s.data ?? "") };
}

function imageSourceToBlock(source: ImagePart["source"]): unknown {
  if (source.kind === "url") return { type: SOURCE.URL, url: source.url };
  return { type: SOURCE.BASE64, media_type: source.mediaType, data: source.data };
}

// --- provider-executed (server) tool blocks ------------------------------

/**
 * Whether a block type is a provider-executed result. Its own `type` is the
 * contract: every such block ends in `_tool_result`, plus the two fixed names.
 */
function isServerResultBlockType(type: unknown): type is string {
  return typeof type === "string" &&
    (type.endsWith(SERVER_TOOL_RESULT_SUFFIX) || type === BLOCK.WEB_SEARCH_RESULT || type === BLOCK.SERVER_TOOL_RESULT);
}

/**
 * The `content` of a result block. This wire models failure as its own content
 * object, not as an array: an error can therefore never be mistaken for an
 * empty result set. The object's type is derived from the block's.
 */
function serverResultContent(blockType: string, content: unknown[], errorCode: string | undefined): unknown {
  if (errorCode === undefined) return content;
  const base = blockType.includes(SERVER_TOOL_INFIX) ? blockType : blockType.replace(RESULT_SUFFIX_RE, SERVER_TOOL_RESULT_SUFFIX);
  return { type: `${base}${ERROR_TYPE_SUFFIX}`, error_code: errorCode };
}

/** The failure code of a result block, which this wire reports as an object in place of the entry array. */
function serverResultErrorCode(content: unknown): string | undefined {
  const code = (content as { error_code?: unknown } | null | undefined)?.error_code;
  return typeof code === "string" ? code : undefined;
}

/** The call block a CLIENT is shown for a provider-executed tool. */
function serverToolUseBlock(id: string, name: string, input: unknown): Record<string, unknown> {
  return { type: BLOCK.SERVER_TOOL_USE, id, name, input: input ?? {}, caller: { type: CALLER_DIRECT } };
}

/** The result block a CLIENT is shown, paired with its call by tool_use_id. `blockType` comes from the
 * tool's own contract, so any result shape an adapter and operator agree on is carried. */
function serverToolResultBlock(part: { blockType: string; id: string; content: unknown[]; errorCode?: string }): Record<string, unknown> {
  return { type: part.blockType, tool_use_id: part.id, caller: { type: CALLER_DIRECT }, content: serverResultContent(part.blockType, part.content, part.errorCode) };
}

// --- usage ---------------------------------------------------------------

function thinkingTokens(usage: Record<string, unknown>): number | undefined {
  return numOrUndef((usage.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens);
}

/** Canonical usage from this wire's exclusive split. */
function usageOf(uncached: number, output: number, cachedRead?: number, cacheWrite?: number, reasoningTokens?: number): Usage {
  const promptTokens = foldCacheIntoPrompt(uncached, cachedRead, cacheWrite);
  return {
    promptTokens,
    completionTokens: output,
    totalTokens: promptTokens + output,
    ...(reasoningTokens != null ? { reasoningTokens } : {}),
    ...cacheCounters(cachedRead, cacheWrite),
  };
}

/** A `usage` object in this wire's exclusive split, buffered or streamed. */
function usageToWire(uncached: number, output: number, cachedRead?: number, cacheWrite?: number, reasoningTokens?: number): Record<string, unknown> {
  return {
    input_tokens: uncached,
    output_tokens: output,
    ...(reasoningTokens != null ? { output_tokens_details: { thinking_tokens: reasoningTokens } } : {}),
    ...(cachedRead != null ? { cache_read_input_tokens: cachedRead } : {}),
    ...(cacheWrite != null ? { cache_creation_input_tokens: cacheWrite } : {}),
  };
}

/**
 * When a reported `input_tokens` / `output_tokens` replaces the running count:
 * always (a non-number reads as 0), whenever the field is present (same
 * reading), or only when it is a number. Each place a `usage` object arrives
 * has its own rule, and they are kept as they were.
 */
type CountRule = "always" | "present" | "numeric";

function counted(current: number, value: unknown, rule: CountRule): number {
  const replace = rule === "always" || (rule === "present" ? value != null : numOrUndef(value) != null);
  return replace ? num(value) : current;
}

/**
 * The running usage of one response, in this wire's own exclusive form
 * (`input` is the uncached remainder) and folded into the canonical inclusive
 * count at every point it leaves. Counters arrive in up to three `usage`
 * objects on a stream and in one on a buffered body; the detail counters
 * (thinking, cache read, cache write) are taken whenever they are numbers.
 */
class UsageCounters {
  input = 0;
  output = 0;
  reasoning: number | undefined;
  cacheRead: number | undefined;
  // Cache WRITES are reported here too, and were the one usage field the
  // streaming path dropped while the buffered path kept it -- so the same
  // request billed a cache write invisibly when it streamed.
  cacheWrite: number | undefined;

  absorb(usage: Record<string, unknown>, rule: { input: CountRule; output: CountRule }): void {
    this.input = counted(this.input, usage.input_tokens, rule.input);
    this.output = counted(this.output, usage.output_tokens, rule.output);
    this.reasoning = thinkingTokens(usage) ?? this.reasoning;
    this.cacheRead = numOrUndef(usage.cache_read_input_tokens) ?? this.cacheRead;
    this.cacheWrite = numOrUndef(usage.cache_creation_input_tokens) ?? this.cacheWrite;
  }

  /** The canonical inclusive prompt count so far. */
  promptTokens(): number {
    return foldCacheIntoPrompt(this.input, this.cacheRead, this.cacheWrite);
  }

  toUsage(): Usage {
    return usageOf(this.input, this.output, this.cacheRead, this.cacheWrite, this.reasoning);
  }
}

/** message_start (and a buffered body): the first report, taken as it stands. */
const COUNT_FIRST = { input: "always", output: "always" } as const;
/** message_delta: output whenever present; some providers report the real prompt count only here, at the end. */
const COUNT_DELTA = { input: "numeric", output: "present" } as const;
/** message_stop: a last correction, numbers only. */
const COUNT_STOP = { input: "numeric", output: "numeric" } as const;

function blocksToParts(content: unknown, pendingUses: Map<string, ToolUsePart> = new Map()): ContentPart[] {
  const text = stringContentParts(content);
  if (text) return text;
  const parts: ContentPart[] = [];
  for (const b of objectsIn(content)) {
    const cc = b.cache_control != null ? { cacheControl: b.cache_control } : {};
    switch (isServerResultBlockType(b.type) ? BLOCK.SERVER_TOOL_RESULT : b.type) {
      case BLOCK.THINKING:
        // An envelope this proxy issued is unwrapped; one it cannot read is not a
        // signature Anthropic issued either, so it is dropped rather than sent on.
        parts.push((typeof b.signature === "string" ? decodeReasoning(b.signature) : null) ?? { type: "reasoning", origin: "anthropic", text: String(b.thinking ?? ""), signature: b.signature != null ? nativeSignature(String(b.signature)) : undefined });
        break;
      case BLOCK.REDACTED_THINKING:
        // Opaque bytes; only a same-family replay can restore them. Never
        // rewrite the text -- a signature over altered text can never verify.
        parts.push({ type: "reasoning", origin: "anthropic", text: "", redacted: true, signature: b.data != null ? String(b.data) : undefined });
        break;
      case BLOCK.TEXT:
        parts.push({ type: "text", text: String(b.text ?? ""), ...cc });
        break;
      case BLOCK.IMAGE:
        parts.push({ type: "image", source: parseImageSource(b.source), ...cc });
        break;
      case BLOCK.DOCUMENT: {
        const src = (b.source ?? {}) as Record<string, unknown>;
        const title = b.title != null ? String(b.title) : undefined;
        if (src.type === SOURCE.URL) parts.push({ type: "file", source: { kind: "url", url: String(src.url ?? "") }, name: title, ...cc });
        else if (src.type === SOURCE.TEXT) parts.push({ type: "text", text: String(src.data ?? ""), ...cc });
        // A handle into Anthropic's own Files API. Kept like the other families'
        // ids: replayed verbatim here, and refused loudly elsewhere rather than
        // dropped, which would send the prompt on without its attachment.
        else if (src.type === SOURCE.FILE && typeof src.file_id === "string" && src.file_id) {
          parts.push({ type: "file", source: { kind: "file_id", id: src.file_id, family: "anthropic" }, name: title, ...cc });
        }
        else if (src.type !== SOURCE.BASE64) throw new FormatConversionError(`unsupported Anthropic document source: ${String(src.type)}`);
        else if (src.data != null) parts.push({ type: "file", source: { kind: "base64", mediaType: String(src.media_type ?? DEFAULT_FILE_MEDIA_TYPE), data: String(src.data) }, name: title, ...cc });
        else throw new FormatConversionError("Anthropic base64 document source is missing data");
        break;
      }
      case BLOCK.TOOL_USE:
        parts.push({ type: "tool_use", id: String(b.id ?? genId(ID_PREFIX.TOOL_USE)), name: String(b.name ?? ""), input: b.input ?? {}, ...cc });
        break;
      case BLOCK.TOOL_RESULT:
        parts.push({
          type: "tool_result",
          toolUseId: String(b.tool_use_id ?? ""),
          content: blocksToParts(b.content, pendingUses).filter((p): p is TextPart | ImagePart => p.type === "text" || p.type === "image"),
          isError: b.is_error === true ? true : undefined,
          ...cc,
        });
        break;
      // A provider-executed pair replayed by a client that received it from us.
      // Kept so a continuation (previous_response_id / full-history resend) does
      // not lose, or silently reduce to text, what the client is showing.
      case BLOCK.SERVER_TOOL_USE: {
        // Back from a client as a pending call: the proxy executes it. It pairs
        // with the result block below when one is present, and is a plain
        // provider-executed call when the turn paused before any result existed.
        const call: ToolUsePart = { type: "tool_use", id: String(b.id ?? genId(ID_PREFIX.SERVER_TOOL)), name: String(b.name ?? ""), input: b.input ?? {}, serverTool: true };
        pendingUses.set(call.id, call);
        parts.push(call);
        break;
      }
      // Any provider-executed result block. Its own `type` is the contract, so a
      // tool configured for another result shape replays without this wire
      // needing to know that shape in advance.
      case BLOCK.SERVER_TOOL_RESULT: {
        const id = String(b.tool_use_id ?? "");
        // This wire reports failure as its own object rather than an entry
        // array, so the code survives a replay as a code, not as empty results.
        const errorCode = serverResultErrorCode(b.content);
        const content = Array.isArray(b.content) ? b.content : [];
        const call = pendingUses.get(id);
        const callIndex = parts.findIndex(p => p.type === "tool_use" && p.serverTool && p.id === id);
        if (callIndex >= 0) parts.splice(callIndex, 1);
        // A result with no call still carries the round trip: the call it refers
        // to was already parsed, and this is the other half of the pair.
        parts.push({
          type: "server_tool_result",
          family: "anthropic",
          id: id || genId(ID_PREFIX.SERVER_TOOL_USE),
          name: call?.name ?? UNKNOWN_SERVER_TOOL_NAME,
          input: call?.input ?? {},
          blockType: String(b.type),
          content,
          ...(errorCode !== undefined ? { errorCode } : {}),
        });
        break;
      }
    }
  }
  return parts;
}

/**
 * A canonical file source as an Anthropic `document.source`. This wire takes
 * inline base64, remote URLs, and its own Files API ids. A file id from ANOTHER
 * family is the one shape it cannot carry: id spaces do not overlap, so
 * forwarding a foreign id either 404s upstream or, worse, resolves to an
 * unrelated document.
 */
function documentSource(source: FileSource): unknown {
  switch (source.kind) {
    case "url":
      return { type: SOURCE.URL, url: source.url };
    case "base64":
      return { type: SOURCE.BASE64, media_type: source.mediaType, data: source.data };
    case "file_id":
      if (source.family === "anthropic") return { type: SOURCE.FILE, file_id: source.id };
      throw foreignFileIdError(source, PROVIDER_LABEL);
  }
}

function partsToBlocks(parts: ContentPart[]): unknown[] {
  const blocks: unknown[] = [];
  const cc = (part: { cacheControl?: unknown }): Record<string, unknown> =>
    part.cacheControl != null ? { cache_control: part.cacheControl } : {};
  for (const p of parts) {
    switch (p.type) {
      case "text":
        blocks.push({ type: BLOCK.TEXT, text: p.text, ...cc(p) });
        break;
      case "reasoning":
        // Foreign opaque data cannot verify on this upstream. Keep readable text only.
        if (p.signature && !isOwnOrigin(p, "anthropic")) {
          if (p.text) blocks.push({ type: BLOCK.TEXT, text: p.text });
          break;
        }
        if (p.redacted) blocks.push({ type: BLOCK.REDACTED_THINKING, data: p.signature ?? "" });
        else blocks.push({ type: BLOCK.THINKING, thinking: p.text, ...(p.signature ? { signature: p.signature } : {}) });
        break;
      case "image":
        blocks.push({ type: BLOCK.IMAGE, source: imageSourceToBlock(p.source), ...cc(p) });
        break;
      case "file":
        blocks.push({
          type: BLOCK.DOCUMENT,
          source: documentSource(p.source),
          ...(p.name ? { title: p.name } : {}),
          ...cc(p),
        });
        break;
      case "server_tool_result":
        if (p.family === "anthropic") {
          blocks.push({ type: BLOCK.SERVER_TOOL_USE, id: p.id, name: p.name, input: p.input });
          // Bound for the upstream, so without the `caller` a client is shown.
          if (!p.notExecuted) blocks.push({ type: p.blockType, tool_use_id: p.id, content: serverResultContent(p.blockType, p.content, p.errorCode) });
        }
        break;
      case "opaque":
        if (p.family === "anthropic") blocks.push(p.value);
        break; // another family's private part; nothing Anthropic can carry
      case "tool_use":
        blocks.push({ type: p.serverTool ? BLOCK.SERVER_TOOL_USE : BLOCK.TOOL_USE, id: p.id, name: p.name, input: p.input ?? {}, ...cc(p) });
        break;
      case "tool_result":
        blocks.push({ type: BLOCK.TOOL_RESULT, tool_use_id: p.toolUseId, content: partsToBlocks(p.content), ...(p.isError ? { is_error: true } : {}), ...cc(p) });
        break;
    }
  }
  return blocks;
}

// --- tools ---------------------------------------------------------------

/**
 * A server-side tool (web_search_20250305, bash, computer use, ...) has a
 * `type` and no input_schema: kept verbatim for same-family replay instead of
 * mangled into an empty-schema client tool. Anything else is a client tool when
 * it has a name, and is dropped when it has none.
 */
const isServerTool = (tool: Record<string, unknown>): boolean => Boolean(tool.type) && tool.input_schema == null;
const TOOL_WIRE: ToolWire = {
  family: "anthropic",
  functionFields: (tool) => (!isServerTool(tool) && tool.name ? tool : undefined),
  schemaKey: "input_schema",
  extras: (tool) => (tool.cache_control != null ? { cacheControl: tool.cache_control } : {}),
  nativeName: (tool) => (isServerTool(tool) ? String(tool.name ?? tool.type) : undefined),
  render: (t) => ({ name: t.name, description: t.description, input_schema: t.parameters, ...(t.cacheControl != null ? { cache_control: t.cacheControl } : {}) }),
};

/** Anthropic's parallel-tools switch lives inside tool_choice. */
function parseDisableParallel(raw: unknown): boolean | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = (raw as Record<string, unknown>).disable_parallel_tool_use;
  return typeof v === "boolean" ? v : undefined;
}

function parseToolChoice(raw: unknown): ToolChoice | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case TOOL_CHOICE.AUTO:
      return { type: "auto" };
    case TOOL_CHOICE.ANY:
      return { type: "required" };
    case TOOL_CHOICE.NONE:
      return { type: "none" };
    case TOOL_CHOICE.TOOL:
      return c.name ? { type: "tool", name: String(c.name) } : { type: "required" };
    default:
      return undefined;
  }
}

function toolChoiceToAnthropic(choice: ToolChoice): unknown {
  switch (choice.type) {
    case "auto":
      return { type: TOOL_CHOICE.AUTO };
    case "none":
      return { type: TOOL_CHOICE.NONE };
    case "required":
      return { type: TOOL_CHOICE.ANY };
    case "tool":
      return { type: TOOL_CHOICE.TOOL, name: choice.name };
  }
}

// --- thinking / params ---------------------------------------------------

function parseThinking(body: Record<string, unknown>): ThinkingLevel | undefined {
  const cfg = body.thinking as Record<string, unknown> | undefined;
  if (!cfg || typeof cfg !== "object") return undefined;
  if (cfg.type === "disabled") return "disabled";
  if (cfg.type === "enabled") {
    const budget = numOrUndef(cfg.budget_tokens);
    return budget != null ? { budget } : "enabled";
  }
  if (cfg.type === "adaptive") {
    const effort = (body.output_config as Record<string, unknown> | undefined)?.effort;
    return isEffortLevel(effort) ? effort : "enabled";
  }
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
  const set = paramSetter(params);
  set("temperature", numOrUndef(body.temperature));
  set("topP", numOrUndef(body.top_p));
  set("topK", numOrUndef(body.top_k));
  set("maxTokens", numOrUndef(body.max_tokens));
  if (Array.isArray(body.stop_sequences)) params.stop = body.stop_sequences.map(String);
  const disableParallel = parseDisableParallel(body.tool_choice);
  if (disableParallel != null) params.parallelToolCalls = !disableParallel;
  // metadata.user_id is this wire's spelling of OpenAI's `user`; translate it so
  // it survives a cross-family hop (same-family metadata still rides passthrough).
  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta.user_id === "string" && meta.user_id) params.user = meta.user_id;
  set("thinking", parseThinking(body));
  if (body.thinking && typeof body.thinking === "object" && !Array.isArray(body.thinking)) {
    params.anthropicThinking = { ...body.thinking as Record<string, unknown> };
  }
  // `metadata` (and any other unmodeled key) rides the family-scoped passthrough,
  // not `extra`: it is an Anthropic-shaped field, so it must reach only Anthropic
  // providers -- `extra` applies to every family and would leak it to OpenAI.
  set("passthrough", collectPassthrough(body, RESERVED, "anthropic"));
  return params;
}

export class AnthropicRequest extends WireRequest {
  readonly family = "anthropic" as const;

  static parse(body: Record<string, unknown>): AnthropicRequest {
    const messages: Message[] = [];
    // Server-tool uses and their results are separate messages, so pairing them
    // needs the whole request, not one message's block list.
    const pendingServerTools = new Map<string, ToolUsePart>();
    for (const m of objectsIn(body.messages)) {
      const role = m.role === "assistant" ? "assistant" : "user";
      messages.push({ role, content: blocksToParts(m.content, pendingServerTools) });
    }
    return new AnthropicRequest({
      requestedService: String(body.model ?? ""),
      system: systemToText(body.system),
      // A block array carries per-block cache_control that the flattened text
      // cannot; keep it for a same-family replay. A plain string system has
      // nothing extra to preserve, so it stays text-only.
      systemBlocks: Array.isArray(body.system) ? body.system : undefined,
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
    // Thinking blocks are kept, not stripped: this family REQUIRES the history's
    // thinking back when thinking mode is on — DeepSeek's Anthropic-compatible
    // endpoint answers a request whose assistant turns have none with
    // "content[].thinking in the thinking mode must be passed back" (4028).
    // They also have to lead their message, which is not the order an OpenAI
    // ingress produces.
    const messages = orderReasoningFirst(this.messages).map((m) => ({ role: m.role, content: partsToBlocks(m.content) }));
    const p = this.params;
    // An OpenAI-family client that signalled caching intent gets the breakpoint
    // planted for it: on the last cacheable block of the last message, so each
    // turn's request caches the whole conversation prefix. A client's own
    // cache_control anywhere in that message wins. Wire accepts 5m/1h only.
    if (p.cacheHint) {
      const last = messages[messages.length - 1];
      const blocks = (last?.content ?? []) as Array<Record<string, unknown>>;
      const hasOwn = blocks.some((b) => b.cache_control != null);
      for (let i = blocks.length - 1; i >= 0 && !hasOwn; i--) {
        const b = blocks[i];
        if (b.type === BLOCK.THINKING || b.type === BLOCK.REDACTED_THINKING) continue;
        b.cache_control = { type: CACHE_CONTROL_EPHEMERAL, ...((p.cacheTtlMinutes ?? DEFAULT_PROMPT_CACHE_TTL_MINUTES) > SHORT_CACHE_TTL_MINUTES ? { ttl: LONG_CACHE_TTL } : {}) };
        break;
      }
    }
    const cap = target.providerMaxOutputTokens;

    const out: Record<string, unknown> = { model: target.upstreamModel, messages };
    // Replay the client's own system blocks when they are still the prompt being
    // sent -- that is what keeps a `cache_control` breakpoint on the system
    // prompt alive across an Anthropic -> Anthropic hop.
    //
    // "Still the prompt" is decided by flattening them and comparing with the
    // effective `system`, rather than by tracking every place that can change
    // it. A step or stage override, a Micro Agent stage rebuild, an appended
    // tool reference: each rewrites `system`, and each therefore drops the stale
    // blocks here automatically. Nothing downstream has to remember to.
    const replayable = this.systemBlocks && systemToText(this.systemBlocks) === this.system;
    if (replayable) out.system = this.systemBlocks;
    else if (this.system) out.system = this.system;
    const tools = renderToolList(this.tools, TOOL_WIRE);
    if (tools) out.tools = tools;
    if (this.toolChoice) out.tool_choice = toolChoiceToAnthropic(this.toolChoice);
    // OpenAI's parallel_tool_calls=false translates to this wire's
    // tool_choice.disable_parallel_tool_use (tool_choice defaults to auto).
    if (p.parallelToolCalls === false) {
      const tc = (out.tool_choice ?? { type: TOOL_CHOICE.AUTO }) as Record<string, unknown>;
      if (tc.type === TOOL_CHOICE.AUTO || tc.type === TOOL_CHOICE.ANY || tc.type === TOOL_CHOICE.TOOL) out.tool_choice = { ...tc, disable_parallel_tool_use: true };
    }
    if (p.temperature != null) out.temperature = clampSampling(p.temperature);
    if (p.topP != null) out.top_p = clampSampling(p.topP);
    if (p.topK != null) out.top_k = p.topK;
    if (p.stop && p.stop.length) out.stop_sequences = p.stop;
    if (this.stream) out.stream = true;
    // This family has no response_format; a JSON contract silently vanishing is
    // worse than a blunt instruction, so say it in the system prompt.
    if (p.responseFormat && p.responseFormat.type !== "text") {
      const schema = p.responseFormat.type === "json_schema" ? ` matching this JSON Schema: ${JSON.stringify(p.responseFormat.schema)}` : "";
      const jsonNote = `Respond ONLY with a valid JSON object${schema}. No prose, no markdown fences.`;
      out.system = this.system ? `${this.system}${SYSTEM_SEPARATOR}${jsonNote}` : jsonNote;
    }

    // `thinking` is emitted ONLY when a level was actually set -- by the client
    // or by a step/stage override. A request that said nothing carries no field,
    // so the provider's own default stands, including a provider that defaults
    // to thinking ON.
    //
    // This reverses an earlier fix, deliberately. DeepSeek's Anthropic-compatible
    // endpoint defaults V4 to thinking ON when the field is missing, then rejects
    // the request with "content[].thinking in the thinking mode must be passed
    // back" (4028) because the assistant turns replayed to it carry no thinking
    // blocks. Pinning {"type":"disabled"} onto every request silenced that -- by
    // disabling thinking for every caller who never asked to have it off. That
    // traded a visible error for an invisible loss of capability, and it breaks
    // outright against an upstream that rejects the field itself rather than
    // honouring it (AMD's /v1/messages answers `"thinking" is not supported for
    // this model. Remove the "thinking" parameter`, so a pinned disable makes
    // EVERY request through that egress fail, thinking or not).
    //
    // The 4028 is the real defect and belongs where it happens: the replayed
    // assistant turns must carry their thinking blocks. Until that is fixed,
    // surfacing 4028 is the correct behaviour. Do NOT re-pin the field to make
    // it go away.
    //
    // The policy still owns max_tokens: it bounds the client's own ceiling by
    // the provider's hard cap. It does NOT substitute one when the client named
    // none -- there is no built-in fallback any more, and this wire's own 400 is
    // what says so (see ir/thinkingFormat.ts's sibling note in ir/thinking.ts).
    const tf = ThinkingPolicy.anthropic(p.thinking ?? "disabled", p.maxTokens, cap, target.upstreamModel);
    if (p.thinking != null) {
      out.thinking = p.anthropicThinking ?? tf.thinking;
      if (tf.effort && !p.anthropicThinking) {
        // `output_config` is shared -- structured outputs live there too -- so an
        // effort merges INTO whatever the client sent rather than replacing it.
        // It cannot ride the passthrough merge for this: that only fills keys the
        // renderer left alone, so writing the key here would drop the client's
        // `format` outright.
        const own = p.passthrough?.family === "anthropic" ? p.passthrough.params.output_config : undefined;
        const base = own && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
        out.output_config = { ...base, effort: tf.effort };
      }
    }
    if (tf.max_tokens != null) out.max_tokens = tf.max_tokens;
    applyNonCanonical(out, p, this.family);
    // OpenAI's `user` abuse-tracking id maps to metadata.user_id; a client's own
    // passthrough metadata (same family) wins.
    if (p.user) {
      const meta = (out.metadata ?? {}) as Record<string, unknown>;
      if (meta.user_id == null) out.metadata = { ...meta, user_id: p.user };
    }
    return out;
  }
}

export class AnthropicResponse extends Response {
  readonly family = "anthropic" as const;

  static isEnvelope(body: Record<string, unknown>): boolean {
    return Array.isArray(body.content);
  }

  static parse(body: Record<string, unknown>): AnthropicResponse {
    const content = blocksToParts(body.content).filter(
      (p) => p.type === "text" || p.type === "tool_use" || p.type === "reasoning" || p.type === "server_tool_result",
    );
    // This wire reports `input_tokens` EXCLUSIVE of both cache counters; the
    // canonical prompt count includes them (ir/usage.ts).
    const usage = new UsageCounters();
    usage.absorb((body.usage ?? {}) as Record<string, unknown>, COUNT_FIRST);
    return new AnthropicResponse({
      id: String(body.id ?? genId(ID_PREFIX.MESSAGE)),
      model: String(body.model ?? ""),
      created: nowSeconds(),
      content,
      stopReason: stopReasonToStop(body.stop_reason as string | null),
      usage: usage.toUsage(),
    });
  }

  /** `opts.thinkingFormat` names a Chat Completions field; this wire has one
   * native thinking block and no field to choose between. The content-level
   * formats (`think_tags`, `none`) were already applied before rendering. */
  renderSelf(model: string, _opts?: RenderOptions): Record<string, unknown> {
    const content: unknown[] = [];
    for (const p of this.content) {
      if (p.type === "reasoning") {
        if (p.redacted) content.push({ type: BLOCK.REDACTED_THINKING, data: p.signature ?? "" });
        else content.push({ type: BLOCK.THINKING, thinking: p.text, ...(p.signature ? { signature: clientSignature(p, "anthropic") } : {}) });
      }
      else if (p.type === "text") content.push({ type: BLOCK.TEXT, text: p.text });
      else if (p.type === "tool_use") content.push(p.serverTool
        ? serverToolUseBlock(p.id, p.name, p.input)
        : { type: BLOCK.TOOL_USE, id: p.id, name: p.name, input: p.input ?? {} });
      else if (p.type === "server_tool_result") {
        // Two blocks, in the order this wire defines: the call the provider made,
        // then its result in the SAME assistant turn, paired by tool_use_id.
        content.push(serverToolUseBlock(p.id, p.name, p.input));
        // A call a pause declined to run stays pending: the call block with no
        // result after it is the shape a client continues from, and inventing an
        // outcome would name a failure that never happened.
        if (p.notExecuted) continue;
        content.push(serverToolResultBlock(p));
      }
    }
    if (content.length === 0) content.push({ type: BLOCK.TEXT, text: "" });
    return {
      id: this.id,
      type: MESSAGE_OBJECT,
      role: ROLE_ASSISTANT,
      model,
      content,
      stop_reason: stopToAnthropic(this.stopReason),
      stop_sequence: null,
      // Back to this wire's exclusive convention: its clients add the three
      // together, so leaving the cache share inside input_tokens would make
      // every cached turn count twice.
      usage: usageToWire(uncachedPromptTokens(this.usage), this.usage.completionTokens, this.usage.cachedInputTokens, this.usage.cacheCreationInputTokens, this.usage.reasoningTokens),
    };
  }

  static async *parseStream(readable: AsyncIterable<Buffer | string>): AsyncGenerator<StreamEvent> {
    let stopReason: StopReason = null;
    const usage = new UsageCounters();
    const toolBlocks = new Set<number>();
    const serverBlocks = new Map<number, { id: string; name: string; input: unknown; args: string }>();
    const serverNames = new Map<string, string>();
    // Thinking blocks stream their signature in a trailing signature_delta;
    // hold it per block and attach it to the reasoning_stop. A redacted block is
    // the exception: its opaque bytes arrive whole in content_block_start.data
    // and no delta of any kind follows, so the payload is captured there.
    const thinkingBlocks = new Map<number, { signature?: string; redacted?: boolean }>();

    for await (const frame of parseSSE(readable)) {
      const data = parseSseJson(frame.data);
      if (!data) continue;
      const type = frame.event ?? String(data.type ?? "");

      switch (type) {
        case EVENT.MESSAGE_START: {
          const message = (data.message ?? {}) as Record<string, unknown>;
          usage.absorb((message.usage ?? {}) as Record<string, unknown>, COUNT_FIRST);
          yield {
            type: "start",
            id: String(message.id ?? genId(ID_PREFIX.MESSAGE)),
            model: String(message.model ?? ""),
            created: nowSeconds(),
            inputTokens: usage.promptTokens(),
            ...cacheCounters(usage.cacheRead, usage.cacheWrite),
          };
          break;
        }
        case EVENT.CONTENT_BLOCK_START: {
          const index = num(data.index);
          const block = (data.content_block ?? {}) as Record<string, unknown>;
          if (block.type === BLOCK.SERVER_TOOL_USE) {
            const call = { id: String(block.id ?? genId(ID_PREFIX.SERVER_TOOL)), name: String(block.name ?? ""), input: block.input ?? {}, args: "" };
            serverBlocks.set(index, call);
            serverNames.set(call.id, call.name);
          } else if (isServerResultBlockType(block.type)) {
            const id = String(block.tool_use_id ?? "");
            const errorCode = serverResultErrorCode(block.content);
            yield { type: "server_tool_result", family: "anthropic", id, name: serverNames.get(id) ?? UNKNOWN_SERVER_TOOL_NAME, blockType: block.type, content: Array.isArray(block.content) ? block.content : [], ...(errorCode !== undefined ? { errorCode } : {}) };
          } else if (block.type === BLOCK.TOOL_USE) {
            toolBlocks.add(index);
            yield { type: "tool_start", index, id: String(block.id ?? genId(ID_PREFIX.TOOL_USE)), name: String(block.name ?? "") };
          } else if (block.type === BLOCK.TEXT) {
            if (typeof block.text === "string" && block.text) yield { type: "text_delta", text: block.text };
          } else if (block.type === BLOCK.THINKING || block.type === BLOCK.REDACTED_THINKING) {
            const redacted = block.type === BLOCK.REDACTED_THINKING;
            const data = redacted && typeof block.data === "string" && block.data ? block.data : undefined;
            thinkingBlocks.set(index, { signature: data ?? (typeof block.signature === "string" ? block.signature : undefined), redacted });
            yield { type: "reasoning_start", origin: "anthropic", ...(redacted ? { redacted: true, signature: data } : {}) };
            if (!redacted && typeof block.thinking === "string" && block.thinking) yield { type: "reasoning_delta", text: block.thinking };
          }
          break;
        }
        case EVENT.CONTENT_BLOCK_DELTA: {
          const index = num(data.index);
          const delta = (data.delta ?? {}) as Record<string, unknown>;
          if (delta.type === DELTA.TEXT && typeof delta.text === "string") yield { type: "text_delta", text: delta.text };
          else if (delta.type === DELTA.THINKING && typeof delta.thinking === "string") yield { type: "reasoning_delta", text: delta.thinking };
          else if (delta.type === DELTA.SIGNATURE && typeof delta.signature === "string") {
            const tb = thinkingBlocks.get(index);
            if (tb) tb.signature = (tb.signature ?? "") + delta.signature;
          }
          else if (delta.type === DELTA.INPUT_JSON && typeof delta.partial_json === "string") {
            const call = serverBlocks.get(index);
            if (call) call.args += delta.partial_json;
            else yield { type: "tool_args_delta", index, delta: delta.partial_json };
          }
          break;
        }
        case EVENT.CONTENT_BLOCK_STOP: {
          const index = num(data.index);
          if (serverBlocks.has(index)) {
            const call = serverBlocks.get(index)!;
            serverBlocks.delete(index);
            yield { type: "server_tool_start", family: "anthropic", id: call.id, name: call.name, input: call.args ? parseToolArguments(call.args) : call.input };
          } else if (toolBlocks.has(index)) {
            toolBlocks.delete(index);
            yield { type: "tool_stop", index };
          } else if (thinkingBlocks.has(index)) {
            const tb = thinkingBlocks.get(index)!;
            thinkingBlocks.delete(index);
            const replay = tb.signature ? decodeReasoning(tb.signature) : null;
            yield { type: "reasoning_stop", origin: replay?.origin ?? "anthropic", id: replay?.itemId, signature: replay?.signature ?? tb.signature, ...(tb.redacted ? { redacted: true } : {}) };
          }
          break;
        }
        case EVENT.MESSAGE_DELTA: {
          const delta = (data.delta ?? {}) as Record<string, unknown>;
          if (delta.stop_reason) stopReason = stopReasonToStop(delta.stop_reason as string);
          usage.absorb((data.usage ?? {}) as Record<string, unknown>, COUNT_DELTA);
          yield { type: "usage", usage: usage.toUsage() };
          break;
        }
        case EVENT.MESSAGE_STOP: {
          usage.absorb((data.usage ?? {}) as Record<string, unknown>, COUNT_STOP);
          yield { type: "finish", stopReason, usage: usage.toUsage() };
          return;
        }
        default:
          break;
      }
    }
    // Reached only when the stream ended without a message_stop -- truncated.
    yield { type: "finish", stopReason, usage: usage.toUsage(), incomplete: true };
  }

  static async *serializeStream(events: AsyncGenerator<StreamEvent>, ctx: StreamContext): AsyncGenerator<string> {
    let id = genId(ID_PREFIX.MESSAGE);
    const model = ctx.model;
    // Held in this wire's own exclusive form, so every frame that states them
    // states the split its clients expect.
    let inputTokens = 0;
    let cacheReadTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let outputTokens = 0;
    let nextIndex = 0;
    let textOpen = false;
    let textIndex = 0;
    let reasoningOpen = false;
    let reasoningIndex = 0;
    // A redacted block must be reproduced as `redacted_thinking` with its opaque
    // data, not dressed up as a `thinking` block: a client replaying an empty
    // thinking block back to the upstream gets the whole request rejected.
    let reasoningRedacted = false;
    let reasoningText = "";
    const toolMap = new Map<number, number>();
    // Client-declared server tools are identified by call id, not by an index
    // the client assigned: the proxy ran them, so there is no request-side index.
    const serverToolIndexes = new Map<string, number>();

    const frame = (event: string, data: Record<string, unknown>): string =>
      sseFrame(JSON.stringify({ type: event, ...data }), event);

    function* closeText(): Generator<string> {
      if (!textOpen) return;
      yield frame(EVENT.CONTENT_BLOCK_STOP, { index: textIndex });
      textOpen = false;
    }
    function* closeReasoning(): Generator<string> {
      if (!reasoningOpen) return;
      yield frame(EVENT.CONTENT_BLOCK_STOP, { index: reasoningIndex });
      reasoningOpen = false;
      reasoningRedacted = false;
    }
    /** Open a thinking block unless one already is. `redactedData` set means a redacted block, which carries its bytes up front. */
    function* openReasoning(redactedData?: string): Generator<string> {
      if (reasoningOpen) return;
      reasoningIndex = nextIndex++;
      reasoningOpen = true;
      reasoningText = "";
      reasoningRedacted = redactedData !== undefined;
      yield frame(EVENT.CONTENT_BLOCK_START, {
        index: reasoningIndex,
        content_block: redactedData !== undefined
          ? { type: BLOCK.REDACTED_THINKING, data: redactedData }
          : { type: BLOCK.THINKING, thinking: "" },
      });
    }
    /** Open a block for a tool call. Any open thinking/text block is closed first: overlapping content
     * blocks make a strict Anthropic client drop the unclosed one (e.g. the thinking block on a text-less,
     * tool-only response). `onIndex` receives the new block's index before its start frame goes out. */
    function* openToolBlock(block: Record<string, unknown>, onIndex: (index: number) => void): Generator<string> {
      yield* closeReasoning();
      yield* closeText();
      const index = nextIndex++;
      onIndex(index);
      yield frame(EVENT.CONTENT_BLOCK_START, { index, content_block: block });
    }

    for await (const ev of events) {
      switch (ev.type) {
        case "start":
          id = ev.id || id;
          cacheReadTokens = ev.cachedInputTokens;
          cacheWriteTokens = ev.cacheCreationInputTokens;
          inputTokens = uncachedPromptTokens({
            promptTokens: ev.inputTokens ?? 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedInputTokens: cacheReadTokens,
            cacheCreationInputTokens: cacheWriteTokens,
          });
          yield frame(EVENT.MESSAGE_START, {
            message: { id, type: MESSAGE_OBJECT, role: ROLE_ASSISTANT, model, content: [], stop_reason: null, stop_sequence: null, usage: usageToWire(inputTokens, 0, cacheReadTokens, cacheWriteTokens) },
          });
          break;
        case "text_delta":
          if (!textOpen) {
            yield* closeReasoning();
            textIndex = nextIndex++;
            textOpen = true;
            yield frame(EVENT.CONTENT_BLOCK_START, { index: textIndex, content_block: { type: BLOCK.TEXT, text: "" } });
          }
          yield frame(EVENT.CONTENT_BLOCK_DELTA, { index: textIndex, delta: { type: DELTA.TEXT, text: ev.text } });
          break;
        case "reasoning_start":
          yield* closeText();
          yield* openReasoning(ev.redacted === true ? ev.signature ?? "" : undefined);
          break;
        case "reasoning_delta":
          yield* closeText();
          yield* openReasoning();
          // A redacted block has no readable thinking to delta; the wire form
          // carries everything it has on the block itself.
          if (!reasoningRedacted) {
            reasoningText += ev.text;
            yield frame(EVENT.CONTENT_BLOCK_DELTA, { index: reasoningIndex, delta: { type: DELTA.THINKING, thinking: ev.text } });
          }
          break;
        case "reasoning_stop":
          if (reasoningOpen) {
            // signature_delta belongs to a thinking block; a redacted block's
            // bytes already went out in its content_block_start.data.
            if (ev.signature && !reasoningRedacted) {
              const signature = clientSignature({ type: "reasoning", text: reasoningText, signature: ev.signature, itemId: ev.id, origin: ev.origin }, "anthropic");
              yield frame(EVENT.CONTENT_BLOCK_DELTA, { index: reasoningIndex, delta: { type: DELTA.SIGNATURE, signature } });
            }
            yield* closeReasoning();
          }
          break;
        case "tool_start":
          yield* openToolBlock({ type: BLOCK.TOOL_USE, id: ev.id, name: ev.name, input: {} }, (idx) => toolMap.set(ev.index, idx));
          break;
        case "tool_args_delta": {
          const idx = toolMap.get(ev.index);
          if (idx != null) yield frame(EVENT.CONTENT_BLOCK_DELTA, { index: idx, delta: { type: DELTA.INPUT_JSON, partial_json: ev.delta } });
          break;
        }
        case "tool_stop": {
          const idx = toolMap.get(ev.index);
          if (idx != null) {
            yield frame(EVENT.CONTENT_BLOCK_STOP, { index: idx });
            toolMap.delete(ev.index);
          }
          break;
        }
        case "server_tool_start":
          yield* openToolBlock(serverToolUseBlock(ev.id, ev.name, ev.input), (idx) => serverToolIndexes.set(ev.id, idx));
          break;
        case "server_tool_result": {
          const idx = serverToolIndexes.get(ev.id) ?? nextIndex++;
          if (serverToolIndexes.has(ev.id)) yield frame(EVENT.CONTENT_BLOCK_STOP, { index: idx });
          serverToolIndexes.delete(ev.id);
          if (ev.notExecuted) break;
          const resultIndex = nextIndex++;
          yield frame(EVENT.CONTENT_BLOCK_START, { index: resultIndex, content_block: serverToolResultBlock(ev) });
          yield frame(EVENT.CONTENT_BLOCK_STOP, { index: resultIndex });
          break;
        }
        case "finish":
          // A truncated upstream must not be dressed up as a finished answer:
          // no message_delta, no message_stop. relay() aborts the connection.
          if (ev.incomplete || ev.error) return;
          yield* closeReasoning();
          yield* closeText();
          for (const idx of toolMap.values()) yield frame(EVENT.CONTENT_BLOCK_STOP, { index: idx });
          toolMap.clear();
          for (const idx of serverToolIndexes.values()) yield frame(EVENT.CONTENT_BLOCK_STOP, { index: idx });
          serverToolIndexes.clear();
          if (ev.usage) {
            inputTokens = uncachedPromptTokens(ev.usage);
            outputTokens = ev.usage.completionTokens;
            if (ev.usage.cachedInputTokens != null) cacheReadTokens = ev.usage.cachedInputTokens;
            if (ev.usage.cacheCreationInputTokens != null) cacheWriteTokens = ev.usage.cacheCreationInputTokens;
          }
          yield frame(EVENT.MESSAGE_DELTA, { delta: { stop_reason: stopToAnthropic(ev.stopReason), stop_sequence: null }, usage: usageToWire(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ev.usage?.reasoningTokens) });
          yield frame(EVENT.MESSAGE_STOP, {});
          break;
      }
    }
  }
}

registerFormat("anthropic", { request: AnthropicRequest, response: AnthropicResponse });
