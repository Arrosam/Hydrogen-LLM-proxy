import type { RenderTarget } from "../ir/request";
import { Response, type RenderOptions } from "../ir/response";
import {
  normalizeMessages,
  stripStaleReasoning,
  textOf,
  type ContentPart,
  type ServerToolResultPart,
  type FileSource,
  type Message,
  type ReasoningPart,
  type StopReason,
  type ToolChoice,
  DEFAULT_SERVER_TOOL_ERROR_CODE,
  SYSTEM_SEPARATOR,
} from "../ir/content";
import { isVerbosity, type GenerationParams, type ResponseFormat, type ThinkingLevel } from "../ir/params";
import { effortToThinking, ThinkingPolicy } from "../ir/thinking";
import { parseSSE, parseSseJson, sseFrame, type StreamContext, type StreamEvent } from "../ir/stream";
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
  openAiJsonSchemaFields,
  OPENAI_ROLE as ROLE,
  TOOL_RESULT_IMAGES_NOTE,
  openAiUsageToWire,
  paramSetter,
  parseDataUrl,
  parseInlineFileData,
  parseOpenAiResponseFormat,
  parseOpenAiUsage,
  stringContentParts,
  type OpenAiUsageKeys,
} from "./wire";
import { boolOrUndef, num, numOrUndef, parseToolArguments, strOrUndef } from "../ir/coerce";
import {
  OPENAI_TOOL_TYPE_FUNCTION as TOOL_TYPE_FUNCTION,
  parseOpenAiToolChoice,
  parseToolList,
  renderOpenAiToolChoice,
  renderToolList,
  type ToolWire,
} from "./tools";
import { RESPONSE_EVENT, RESPONSE_STATUS, RUNNING_RESPONSE_STATUSES, type ResponseStatus } from "./responsesWire";
import type { Usage } from "../ir/usage";
import { clientSignature, decodeReasoning, encodeRedacted, isOwnOrigin, nativeSignature } from "./reasoningBridge";
import { registerFormat } from "./registry";
import { WireRequest } from "./wireRequest";

/**
 * OpenAI Responses API (/v1/responses), both directions: clients (Codex CLI,
 * newer OpenAI SDK apps) speak it to the proxy, and "openai_responses" providers
 * are called with it upstream.
 */

// --- wire identifiers ----------------------------------------------------

/** Output / input item types. `web_search_call` is also the block type a search round trip is carried as. */
const ITEM = {
  MESSAGE: "message",
  REASONING: "reasoning",
  FUNCTION_CALL: "function_call",
  FUNCTION_CALL_OUTPUT: "function_call_output",
  WEB_SEARCH_CALL: "web_search_call",
} as const;

/** Content part types (message content, reasoning summary / content). */
const PART = {
  TEXT: "text",
  INPUT_TEXT: "input_text",
  OUTPUT_TEXT: "output_text",
  INPUT_IMAGE: "input_image",
  INPUT_FILE: "input_file",
  REFUSAL: "refusal",
  SUMMARY_TEXT: "summary_text",
  REASONING_TEXT: "reasoning_text",
} as const;

/** Item- and part-level SSE event types; the response-level ones are RESPONSE_EVENT. */
const EVENT = {
  OUTPUT_ITEM_ADDED: "response.output_item.added",
  OUTPUT_ITEM_DONE: "response.output_item.done",
  OUTPUT_TEXT_DELTA: "response.output_text.delta",
  OUTPUT_TEXT_DONE: "response.output_text.done",
  REFUSAL_DELTA: "response.refusal.delta",
  REFUSAL_DONE: "response.refusal.done",
  REASONING_SUMMARY_TEXT_DELTA: "response.reasoning_summary_text.delta",
  REASONING_SUMMARY_TEXT_DONE: "response.reasoning_summary_text.done",
  REASONING_TEXT_DELTA: "response.reasoning_text.delta",
  REASONING_SUMMARY_PART_ADDED: "response.reasoning_summary_part.added",
  REASONING_SUMMARY_PART_DONE: "response.reasoning_summary_part.done",
  CONTENT_PART_ADDED: "response.content_part.added",
  CONTENT_PART_DONE: "response.content_part.done",
  FUNCTION_CALL_ARGUMENTS_DELTA: "response.function_call_arguments.delta",
  FUNCTION_CALL_ARGUMENTS_DONE: "response.function_call_arguments.done",
} as const;

/** Every event type of this wire starts with this. */
const RESPONSE_EVENT_PREFIX = "response.";

const OBJECT_RESPONSE = "response";

/** `incomplete_details.reason` values. */
const INCOMPLETE_REASON = {
  PAUSE_TURN: "pause_turn",
  CONTENT_FILTER: "content_filter",
  MAX_OUTPUT_TOKENS: "max_output_tokens",
} as const;

/** Where this wire's `usage` object keeps its counters. */
const USAGE_KEYS: OpenAiUsageKeys = {
  prompt: "input_tokens",
  completion: "output_tokens",
  promptDetails: "input_tokens_details",
  completionDetails: "output_tokens_details",
};

/** Statuses of a buffered response object that is not a finished answer. */
const UNFINISHED_STATUSES: readonly unknown[] = [RESPONSE_STATUS.FAILED, RESPONSE_STATUS.CANCELLED, ...RUNNING_RESPONSE_STATUSES];

/** The provider name a conversion refusal reports. */
const PROVIDER_LABEL = "an OpenAI Responses";

/** Name of the built-in search tool, and the web_search_call status of a search still running. */
const WEB_SEARCH_TOOL_NAME = "web_search";
const WEB_SEARCH_STATUS_SEARCHING = "searching";

// --- content -------------------------------------------------------------

function parseSearchCall(item: Record<string, unknown>): ServerToolResultPart {
  const action = (item.action ?? {}) as Record<string, unknown>;
  return { type: "server_tool_result", family: "openai_responses", id: String(item.id ?? genId(ID_PREFIX.WEB_SEARCH)), name: WEB_SEARCH_TOOL_NAME,
    input: action, blockType: ITEM.WEB_SEARCH_CALL, content: Array.isArray(action.sources) ? action.sources : [],
    ...(item.status === RESPONSE_STATUS.FAILED ? { errorCode: DEFAULT_SERVER_TOOL_ERROR_CODE } : {}),
    ...(item.status === RESPONSE_STATUS.IN_PROGRESS || item.status === WEB_SEARCH_STATUS_SEARCHING ? { notExecuted: true } : {}) };
}
function renderSearchCall(p: ServerToolResultPart): Record<string, unknown> {
  const action = (p.input ?? {}) as Record<string, unknown>;
  return { id: p.id, type: ITEM.WEB_SEARCH_CALL, status: p.notExecuted ? RESPONSE_STATUS.IN_PROGRESS : p.errorCode !== undefined ? RESPONSE_STATUS.FAILED : RESPONSE_STATUS.COMPLETED,
    action: { type: "search", ...action, ...(p.content.length ? { sources: p.content.filter((entry): entry is { url: string } => entry !== null && typeof entry === "object" && typeof (entry as { url?: unknown }).url === "string").map(entry => ({ type: "url", ...entry })) } : {}) } };
}

/** A search the model asked for that has not run: the item a paused turn hands the client. */
function pendingSearchCall(id: string, name: string, input: unknown): Record<string, unknown> {
  return renderSearchCall({ type: "server_tool_result", family: "openai_responses", id, name, input, blockType: ITEM.WEB_SEARCH_CALL, content: [], notExecuted: true });
}

function contentToParts(content: unknown): ContentPart[] {
  const text = stringContentParts(content);
  if (text) return text;
  const parts: ContentPart[] = [];
  for (const part of objectsIn(content)) {
    switch (part.type) {
      case PART.INPUT_TEXT:
      case PART.OUTPUT_TEXT:
      case PART.TEXT:
        parts.push({ type: "text", text: String(part.text ?? "") });
        break;
      case PART.INPUT_IMAGE: {
        const url = imageUrlField(part.image_url);
        if (url) parts.push({ type: "image", source: parseDataUrl(url) });
        break;
      }
      case PART.INPUT_FILE: {
        const name = part.filename != null ? String(part.filename) : undefined;
        if (typeof part.file_url === "string" && part.file_url) {
          parts.push({ type: "file", source: { kind: "url", url: part.file_url }, name });
        } else if (typeof part.file_data === "string" && part.file_data) {
          parts.push({ type: "file", source: parseInlineFileData(part.file_data), name });
        } else if (typeof part.file_id === "string" && part.file_id) {
          // A handle into this API's own file storage. Kept so a Responses ->
          // Responses hop restores it verbatim; another family cannot resolve
          // it and now says so instead of dropping the attachment.
          parts.push({ type: "file", source: { kind: "file_id", id: part.file_id, family: "openai_responses" }, name });
        }
        break;
      }
      case PART.REFUSAL:
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
      return { file_data: dataUrlOf(source.mediaType, source.data) };
    case "url":
      return { file_url: source.url };
    case "file_id":
      if (source.family !== "openai_responses") throw foreignFileIdError(source, PROVIDER_LABEL);
      return { file_id: source.id };
  }
}

/** function_call_output "output": a string, or an array of text parts. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return textOf(contentToParts(output));
}

// --- tools ---------------------------------------------------------------

/**
 * Responses tools are flattened (no nested "function" object). Anything that is
 * not a named function tool is a built-in (web_search, file_search,
 * code_interpreter, mcp, ...): kept verbatim for same-family replay instead of
 * dropped, as long as it says what it is.
 */
const TOOL_WIRE: ToolWire = {
  family: "openai_responses",
  functionFields: (tool) => (tool.type === TOOL_TYPE_FUNCTION && tool.name ? tool : undefined),
  schemaKey: "parameters",
  extras: (tool) => (typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
  nativeName: (tool) => (tool.type ? String(tool.name ?? tool.type) : undefined),
  render: (t) => ({ type: TOOL_TYPE_FUNCTION, name: t.name, description: t.description, parameters: t.parameters, ...(t.strict != null ? { strict: t.strict } : {}) }),
};

/** The object form names the tool at the top level and must say it is a function. */
function parseToolChoice(raw: unknown): ToolChoice | undefined {
  return parseOpenAiToolChoice(raw, (c) => c.type === TOOL_TYPE_FUNCTION && c.name);
}

function toolChoiceToResponses(choice: ToolChoice): unknown {
  return renderOpenAiToolChoice(choice, (name) => ({ type: TOOL_TYPE_FUNCTION, name }));
}

// --- response_format (text.format) ---------------------------------------

/** The format sits under `text.format`, with the json_schema fields on the format object itself. */
function parseResponseFormat(text: unknown): ResponseFormat | undefined {
  if (!text || typeof text !== "object") return undefined;
  return parseOpenAiResponseFormat((text as Record<string, unknown>).format, (format) => format);
}

function responseFormatToResponses(rf: ResponseFormat): unknown {
  if (rf.type === "json_schema") return { format: { type: rf.type, ...openAiJsonSchemaFields(rf) } };
  return { format: { type: rf.type } };
}

// --- thinking / params ---------------------------------------------------

function parseThinking(raw: unknown): ThinkingLevel | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return effortToThinking((raw as Record<string, unknown>).effort);
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
  const set = paramSetter(params);
  set("temperature", numOrUndef(body.temperature));
  set("topP", numOrUndef(body.top_p));
  set("maxTokens", numOrUndef(body.max_output_tokens));
  if (body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) params.responsesReasoning = { ...body.reasoning as Record<string, unknown> };
  if (body.text && typeof body.text === "object" && !Array.isArray(body.text)) {
    params.responsesText = { ...body.text as Record<string, unknown> };
    const verbosity = params.responsesText.verbosity;
    if (isVerbosity(verbosity)) params.verbosity = verbosity;
  }
  set("thinking", parseThinking(body.reasoning));
  set("responseFormat", parseResponseFormat(body.text));
  set("parallelToolCalls", boolOrUndef(body.parallel_tool_calls));
  set("serviceTier", strOrUndef(body.service_tier));
  set("user", strOrUndef(body.user));
  if (hasCacheHint(body)) params.cacheHint = true;
  set("passthrough", collectPassthrough(body, RESERVED, "openai_responses"));
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
  return joinTexts(item.content, PART.REASONING_TEXT) || joinTexts(item.summary, PART.SUMMARY_TEXT);
}

/** A reasoning item's `encrypted_content`, when it carries one. */
function encryptedContentOf(item: Record<string, unknown>): string | undefined {
  return typeof item.encrypted_content === "string" && item.encrypted_content ? item.encrypted_content : undefined;
}

/**
 * A "reasoning" item as a canonical part, or null when it carries nothing.
 *
 * Raw chain of thought (content[].reasoning_text) or summary, whichever the
 * server produced. encrypted_content and the item id ride along so a
 * same-family replay restores the item. An envelope this proxy wrapped on the
 * way out (see reasoningBridge) is unwrapped instead, so the canonical part is
 * the block its issuing family knows and that upstream gets the real thing back.
 * An envelope that cannot be read is dropped: it is nobody's native payload.
 */
function parseReasoningItem(item: Record<string, unknown>): ReasoningPart | null {
  const text = reasoningItemText(item);
  const encrypted = encryptedContentOf(item);
  const replay = encrypted ? decodeReasoning(encrypted) : null;
  if (replay) return replay;
  const signature = nativeSignature(encrypted);
  if (!text && !signature) return null;
  return {
    type: "reasoning",
    text,
    signature,
    origin: "openai_responses",
    itemId: typeof item.id === "string" && item.id ? item.id : undefined,
  };
}

/**
 * The fields of a reasoning item after its `type` and `id` (which the buffered
 * and streamed shapes order differently): the summary, the raw text when there
 * is any, and the opaque payload when one is attached. WHICH payload -- a
 * native signature, or this proxy's envelope for a client -- is the caller's
 * decision, so the never-across-families rule stays visible at each call site.
 */
function reasoningItemBody(text: string, encrypted?: string): Record<string, unknown> {
  return {
    summary: text ? [{ type: PART.SUMMARY_TEXT, text }] : [],
    ...(text ? { content: [{ type: PART.REASONING_TEXT, text }] } : {}),
    ...(encrypted ? { encrypted_content: encrypted } : {}),
  };
}

/** A completed assistant message item of a buffered response. */
function messageItem(text: string): Record<string, unknown> {
  return { type: ITEM.MESSAGE, id: genId(ID_PREFIX.MESSAGE), status: RESPONSE_STATUS.COMPLETED, role: ROLE.ASSISTANT, content: [{ type: PART.OUTPUT_TEXT, text, annotations: [] }] };
}

// --- stop reason mapping -------------------------------------------------

/**
 * This wire has no "paused" status: a turn that asks to be continued is
 * `incomplete` with its own reason, and only that reason distinguishes it from
 * a token-limit stop. A finished turn stops for a tool call or just stops.
 */
function responsesStatusToStop(incomplete: boolean, incompleteReason: unknown, sawToolCall: boolean): StopReason {
  if (!incomplete) return sawToolCall ? "tool_use" : "stop";
  if (incompleteReason === INCOMPLETE_REASON.PAUSE_TURN) return "pause_turn";
  return incompleteReason === INCOMPLETE_REASON.CONTENT_FILTER ? "content_filter" : "length";
}

/** The `status` and `incomplete_details` a stop reason is reported as. The client resumes a paused turn by
 * sending the response back, so the reason has to say which kind of "not finished" this is. */
export function stopToResponsesStatus(stop: StopReason): { status: ResponseStatus; incompleteDetails: { reason: string } | null } {
  switch (stop) {
    case "pause_turn":
      return { status: RESPONSE_STATUS.INCOMPLETE, incompleteDetails: { reason: INCOMPLETE_REASON.PAUSE_TURN } };
    case "content_filter":
      return { status: RESPONSE_STATUS.INCOMPLETE, incompleteDetails: { reason: INCOMPLETE_REASON.CONTENT_FILTER } };
    case "length":
      return { status: RESPONSE_STATUS.INCOMPLETE, incompleteDetails: { reason: INCOMPLETE_REASON.MAX_OUTPUT_TOKENS } };
    default:
      return { status: RESPONSE_STATUS.COMPLETED, incompleteDetails: null };
  }
}

// --- request subclass ----------------------------------------------------

export class OpenAIResponsesRequest extends WireRequest {
  readonly family = "openai_responses" as const;

  static parse(body: Record<string, unknown>): OpenAIResponsesRequest {
    const systemChunks: string[] = [];
    if (typeof body.instructions === "string" && body.instructions) systemChunks.push(body.instructions);

    const messages: Message[] = [];
    const input = body.input;
    if (typeof input === "string") {
      if (input) messages.push({ role: "user", content: [{ type: "text", text: input }] });
    } else {
      for (const item of objectsIn(input)) {
        const type = item.type ?? ITEM.MESSAGE;
        if (type === ITEM.MESSAGE) {
          const role = String(item.role ?? ROLE.USER);
          const parts = contentToParts(item.content);
          if (role === ROLE.SYSTEM || role === ROLE.DEVELOPER) {
            const text = textOf(parts);
            if (text) systemChunks.push(text);
          } else if (parts.length) {
            messages.push({ role: role === ROLE.ASSISTANT ? "assistant" : "user", content: parts });
          }
        } else if (type === ITEM.FUNCTION_CALL) {
          messages.push({
            role: "assistant",
            content: [{ type: "tool_use", id: String(item.call_id ?? genId(ID_PREFIX.CALL)), name: String(item.name ?? ""), input: parseToolArguments(item.arguments) }],
          });
        } else if (type === ITEM.WEB_SEARCH_CALL) {
          const p = parseSearchCall(item);
          messages.push({ role: "assistant", content: [p.notExecuted ? { type: "tool_use", serverTool: true, id: p.id, name: p.name, input: p.input } : p] });
        } else if (type === ITEM.FUNCTION_CALL_OUTPUT) {
          messages.push({
            role: "user",
            content: [{ type: "tool_result", toolUseId: String(item.call_id ?? ""), content: [{ type: "text", text: outputText(item.output) }] }],
          });
        } else if (type === ITEM.REASONING) {
          // Replayed thinking is parsed, NOT dropped: what may be resent is the
          // EGRESS family's rule. An Anthropic-family target requires the
          // history's thinking back (DeepSeek's 4028), and this family's own
          // render replays it too — DeepSeek-family Responses upstreams 400 a
          // thinking-mode tool loop whose reasoning_text is not passed back.
          // A reasoning item precedes its turn's message/function_call items,
          // so normalizeMessages folds it in front of them — the order every
          // family wants.
          const part = parseReasoningItem(item);
          if (part) messages.push({ role: "assistant", content: [part] });
        }
      }
    }

    return new OpenAIResponsesRequest({
      requestedService: String(body.model ?? ""),
      system: systemChunks.length ? systemChunks.join(SYSTEM_SEPARATOR) : undefined,
      // Reasoning is NOT stripped here: what a target may be sent back is the
      // egress family's rule, applied at render time (this family and the
      // Anthropic renderer both replay it; stale tool-less turns are shed by
      // stripStaleReasoning in the renderers that call it).
      messages: normalizeMessages(messages),
      tools: parseToolList(body.tools, TOOL_WIRE),
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
          parts.push({ type: m.role === "assistant" ? PART.OUTPUT_TEXT : PART.INPUT_TEXT, text: p.text });
        } else if (p.type === "image") {
          parts.push({ type: PART.INPUT_IMAGE, image_url: imageUrlOf(p.source) });
        } else if (p.type === "file") {
          parts.push({ type: PART.INPUT_FILE, ...(p.name ? { filename: p.name } : {}), ...inputFileRef(p.source) });
        } else if (p.type === "opaque") {
          if (p.family === "openai_responses") parts.push(p.value as Record<string, unknown>);
        } else if (p.type === "server_tool_result") {
          if (p.family === "openai_responses") { flushParts(); input.push(renderSearchCall(p)); }
        } else if (p.type === "tool_use") {
          flushParts();
          input.push(p.serverTool ? pendingSearchCall(p.id, p.name, p.input)
            : { type: ITEM.FUNCTION_CALL, call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}) });
        } else if (p.type === "tool_result") {
          flushParts();
          input.push({ type: ITEM.FUNCTION_CALL_OUTPUT, call_id: p.toolUseId, output: textOf(p.content) });
          // function_call_output is text-only: carry the result's images in a
          // follow-up user message instead of dropping them (screenshot loops).
          const images = p.content.filter((c) => c.type === "image");
          if (images.length) {
            input.push({
              role: ROLE.USER,
              content: [
                { type: PART.INPUT_TEXT, text: TOOL_RESULT_IMAGES_NOTE },
                ...images.map((img) => ({ type: PART.INPUT_IMAGE, image_url: imageUrlOf((img as Extract<ContentPart, { type: "image" }>).source) })),
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
          // Bound for an upstream: only this family's own id and payload go back.
          const own = isOwnOrigin(p, "openai_responses");
          input.push({
            type: ITEM.REASONING,
            id: (own ? p.itemId : undefined) ?? genId(ID_PREFIX.REASONING),
            ...reasoningItemBody(p.text, own ? p.signature : undefined),
          });
        }
      }
      flushParts();
    }

    const p = this.params;
    // Provider-side storage is disabled; Hydrogen manages ingress state locally.
    const out: Record<string, unknown> = { model: target.upstreamModel, input, store: false };
    if (this.system) out.instructions = this.system;
    const tools = renderToolList(this.tools, TOOL_WIRE);
    if (tools) out.tools = tools;
    if (this.toolChoice) out.tool_choice = toolChoiceToResponses(this.toolChoice);
    if (p.responsesReasoning) out.reasoning = { ...p.responsesReasoning };
    if (p.responsesText) out.text = { ...p.responsesText };
    // The thinking policy owns max_output_tokens when reasoning is on: the
    // reasoning is spent out of that same ceiling, so it has to size it.
    const ceiling = ThinkingPolicy.openai(p.thinking, p.maxTokens, target.providerMaxOutputTokens);
    if (ceiling.effort != null) out.reasoning = { ...p.responsesReasoning, effort: ceiling.effort };
    if (ceiling.maxTokens != null) out.max_output_tokens = ceiling.maxTokens;
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
}

// --- response subclass ---------------------------------------------------

export class OpenAIResponsesResponse extends Response {
  readonly family = "openai_responses" as const;

  static isEnvelope(body: Record<string, unknown>): boolean {
    return Array.isArray(body.output);
  }

  /** A response object states its own status: failed, cancelled, or still queued / running, it is not an answer. */
  static override isUnfinished(body: Record<string, unknown>): boolean {
    return UNFINISHED_STATUSES.includes(body.status);
  }

  static parse(body: Record<string, unknown>): OpenAIResponsesResponse {
    const content: ContentPart[] = [];
    let sawToolCall = false;
    for (const item of objectsIn(body.output)) {
      if (item.type === ITEM.REASONING) {
        const part = parseReasoningItem(item);
        if (part) content.push(part);
      } else if (item.type === ITEM.MESSAGE) {
        const text = textOf(contentToParts(item.content));
        if (text) content.push({ type: "text", text });
      } else if (item.type === ITEM.WEB_SEARCH_CALL) {
        content.push(parseSearchCall(item));
      } else if (item.type === ITEM.FUNCTION_CALL) {
        sawToolCall = true;
        content.push({ type: "tool_use", id: String(item.call_id ?? item.id ?? genId(ID_PREFIX.CALL)), name: String(item.name ?? ""), input: parseToolArguments(item.arguments) });
      }
    }

    const incompleteReason = ((body.incomplete_details ?? {}) as Record<string, unknown>).reason;
    return new OpenAIResponsesResponse({
      id: String(body.id ?? genId(ID_PREFIX.RESPONSE)),
      model: String(body.model ?? ""),
      created: numOrUndef(body.created_at) ?? 0,
      content,
      stopReason: responsesStatusToStop(body.status === RESPONSE_STATUS.INCOMPLETE, incompleteReason, sawToolCall),
      usage: parseOpenAiUsage((body.usage ?? {}) as Record<string, unknown>, USAGE_KEYS),
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
      output.push({
        type: ITEM.REASONING,
        id: p.itemId ?? genId(ID_PREFIX.REASONING),
        ...(p.redacted ? reasoningItemBody("", encodeRedacted(p)) : reasoningItemBody(p.text, clientSignature(p, "openai_responses"))),
      });
    }

    // A provider-executed round trip is ONE item on this wire, not a call block
    // plus a result block: `web_search_call` carries the action and the sources
    // it used, and the API runs it — there is nothing for the client to answer.
    // Only the entry URLs fit: this wire's source shape is `{ type: "url", url }`.
    for (const p of this.content) {
      if (p.type === "server_tool_result") output.push(renderSearchCall(p));
    }

    const text = textOf(this.content);
    if (text) output.push(messageItem(text));

    for (const p of this.content) {
      if (p.type === "tool_use") {
        output.push(p.serverTool ? pendingSearchCall(p.id, p.name, p.input)
          : { type: ITEM.FUNCTION_CALL, id: genId(ID_PREFIX.FUNCTION_CALL), call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}), status: RESPONSE_STATUS.COMPLETED });
      }
    }

    if (output.length === 0) output.push(messageItem(""));

    const { status, incompleteDetails } = stopToResponsesStatus(this.stopReason);
    return {
      id: genId(ID_PREFIX.RESPONSE),
      object: OBJECT_RESPONSE,
      created_at: this.created,
      status,
      error: null,
      incomplete_details: incompleteDetails,
      model,
      output,
      usage: openAiUsageToWire(this.usage, USAGE_KEYS),
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
    /** The one `start` this stream owes, from whichever `response` snapshot arrives first. */
    function* ensureStarted(r: Record<string, unknown>): Generator<StreamEvent> {
      if (started) return;
      started = true;
      yield { type: "start", id: String(r.id ?? genId(ID_PREFIX.RESPONSE)), model: String(r.model ?? ""), created: num(r.created_at) || nowSeconds() };
    }
    function* emitMessage(item: Record<string, unknown>, outputIndex: unknown): Generator<StreamEvent> {
      if (item.type !== ITEM.MESSAGE || !Array.isArray(item.content)) return;
      for (const [contentIndex, raw] of item.content.entries()) {
        if (!raw || typeof raw !== "object") continue;
        const part = raw as Record<string, unknown>;
        if (part.type === PART.OUTPUT_TEXT || part.type === PART.TEXT || part.type === PART.REFUSAL) {
          yield* emitText({ item_id: item.id, output_index: outputIndex, content_index: contentIndex }, part.type === PART.REFUSAL ? part.refusal : part.text, true);
        }
      }
    }

    const finishedItems = new Set<string>();
    const toolArguments = new Map<number, string>();
    const toolStart = (index: number, item: Record<string, unknown>): StreamEvent =>
      ({ type: "tool_start", index, id: String(item.call_id ?? item.id ?? genId(ID_PREFIX.CALL)), name: String(item.name ?? "") });
    function* startReasoning(itemId: string): Generator<StreamEvent> {
      if (reasoningStarted.has(itemId)) return;
      reasoningStarted.add(itemId);
      yield { type: "reasoning_start", origin: "openai_responses", id: itemId };
    }
    function* finishItem(item: Record<string, unknown>, outputIndex: unknown): Generator<StreamEvent> {
      if (item.type === ITEM.MESSAGE) { yield* emitMessage(item, outputIndex); return; }
      const itemId = String(item.id ?? item.call_id ?? (item.type === ITEM.REASONING ? currentReasoningId : undefined) ?? outputIndex ?? "0");
      const key = String(item.type) + ":" + itemId;
      if (finishedItems.has(key)) return;
      if (item.type === ITEM.WEB_SEARCH_CALL) {
        const p = parseSearchCall(item);
        yield { type: "server_tool_start", family: p.family, id: p.id, name: p.name, input: p.input };
        yield { type: "server_tool_result", family: p.family, id: p.id, name: p.name, blockType: p.blockType, content: p.content, errorCode: p.errorCode, notExecuted: p.notExecuted };
      } else if (item.type === ITEM.REASONING) {
        yield* startReasoning(itemId);
        if (!reasoningWithText.has(itemId)) {
          const text = reasoningItemText(item);
          if (text) yield { type: "reasoning_delta", text };
        }
        const encrypted = encryptedContentOf(item);
        const replay = encrypted ? decodeReasoning(encrypted) : null;
        yield { type: "reasoning_stop", origin: replay?.origin ?? "openai_responses", id: replay?.itemId ?? itemId, signature: replay?.signature ?? encrypted, redacted: replay?.redacted };
        if (currentReasoningId === itemId) currentReasoningId = undefined;

      } else if (item.type === ITEM.FUNCTION_CALL) {
        sawToolCall = true;
        let index = toolIndexByItem.get(itemId);
        if (index == null) {
          index = nextToolIndex++;
          toolIndexByItem.set(itemId, index);
          yield toolStart(index, item);
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
      const data = parseSseJson(frame.data);
      if (!data) continue;
      const type = frame.event ?? String(data.type ?? "");

      if (type.startsWith(RESPONSE_EVENT_PREFIX)) yield* ensureStarted((data.response ?? {}) as Record<string, unknown>);

      switch (type) {
        case EVENT.OUTPUT_TEXT_DELTA:
        case EVENT.REFUSAL_DELTA:
          yield* emitText(data, data.delta, false);
          break;
        case EVENT.OUTPUT_TEXT_DONE:
          yield* emitText(data, data.text, true);
          break;
        case EVENT.REFUSAL_DONE:
          yield* emitText(data, data.refusal, true);
          break;
        case EVENT.REASONING_SUMMARY_TEXT_DELTA:
        case EVENT.REASONING_TEXT_DELTA: {
          const itemId = typeof data.item_id === "string" && data.item_id ? data.item_id : currentReasoningId;
          if (itemId && !reasoningStarted.has(itemId)) {
            currentReasoningId = itemId;
            yield* startReasoning(itemId);
          }
          if (typeof data.delta === "string" && data.delta) {
            reasoningWithText.add(itemId ?? "");
            yield { type: "reasoning_delta", text: data.delta };
          }
          break;
        }
        case EVENT.OUTPUT_ITEM_ADDED: {
          const item = (data.item ?? {}) as Record<string, unknown>;
          if (item.type === ITEM.REASONING) {
            const itemId = String(item.id ?? genId(ID_PREFIX.REASONING));
            currentReasoningId = itemId;
            yield* startReasoning(itemId);
          } else if (item.type === ITEM.FUNCTION_CALL) {
            sawToolCall = true;
            const index = nextToolIndex++;
            toolIndexByItem.set(String(item.id ?? item.call_id ?? index), index);
            yield toolStart(index, item);
          }
          break;
        }
        case EVENT.FUNCTION_CALL_ARGUMENTS_DELTA: {
          const index = toolIndexByItem.get(String(data.item_id ?? ""));
          if (index != null && typeof data.delta === "string" && data.delta) {
            toolArguments.set(index, (toolArguments.get(index) ?? "") + data.delta);
            yield { type: "tool_args_delta", index, delta: data.delta };
          }
          break;
        }
        case EVENT.OUTPUT_ITEM_DONE: {
          yield* finishItem((data.item ?? {}) as Record<string, unknown>, data.output_index);
          break;
        }
        case RESPONSE_EVENT.COMPLETED:
        case RESPONSE_EVENT.INCOMPLETE:
        case RESPONSE_EVENT.FAILED: {
          const r = (data.response ?? {}) as Record<string, unknown>;
          const u = (r.usage ?? {}) as Record<string, unknown>;
          if (u.input_tokens != null || u.output_tokens != null) usage = parseOpenAiUsage(u, USAGE_KEYS, { zeroTotalIsMissing: true });
          // A failed generation is not an answer: flag it incomplete so the
          // buffered path reports a retryable failure and the streamed path
          // aborts the connection, instead of relaying a failure as a completed
          // response. `incomplete` (max_output_tokens) is a legitimate length
          // stop and stays a normal finish.
          if (type === RESPONSE_EVENT.FAILED) {
            yield { type: "finish", stopReason: sawToolCall ? "tool_use" : "stop", usage, incomplete: true };
            return;
          }
          yield* ensureStarted(r);
          if (Array.isArray(r.output)) {
            for (const [index, item] of r.output.entries()) {
              if (item && typeof item === "object") yield* finishItem(item as Record<string, unknown>, index);
            }
          }
          // An incomplete turn says WHY it stopped; only the reason tells a
          // paused loop apart from a token limit.
          const why = ((r.incomplete_details ?? {}) as Record<string, unknown>).reason;
          yield { type: "finish", stopReason: responsesStatusToStop(type === RESPONSE_EVENT.INCOMPLETE, why, sawToolCall), usage };
          return;
        }
        default:
          break;
      }
    }
    yield* ensureStarted({});
    // Reached only when the stream ended without a terminal event -- truncated.
    yield { type: "finish", stopReason: sawToolCall ? "tool_use" : "stop", usage, incomplete: true };
  }

  static async *serializeStream(events: AsyncGenerator<StreamEvent>, ctx: StreamContext): AsyncGenerator<string> {
    const id = genId(ID_PREFIX.RESPONSE);
    let created = nowSeconds();
    const model = ctx.model;
    let seq = 0;
    const frame = (event: string, data: Record<string, unknown>): string =>
      sseFrame(JSON.stringify({ type: event, sequence_number: seq++, ...data }), event);

    const response = (status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      id, object: OBJECT_RESPONSE, created_at: created, status, error: null, incomplete_details: null, model, output: [], ...extra,
    });

    const serverInputs = new Map<string, unknown>();
    const output: Record<string, unknown>[] = [];
    let outputIndex = 0;

    let msgId = "";
    let msgText: string | null = null; // null = no message item open
    let reasoningId = "";
    let reasoningText: string | null = null;
    let reasoningSignature: string | undefined;
    const tools = new Map<number, OpenTool>();

    function* openReasoning(itemId?: string): Generator<string> {
      reasoningId = itemId || genId(ID_PREFIX.REASONING);
      reasoningText = "";
      reasoningSignature = undefined;
      yield frame(EVENT.OUTPUT_ITEM_ADDED, { output_index: outputIndex, item: { id: reasoningId, type: ITEM.REASONING, summary: [] } });
      yield frame(EVENT.REASONING_SUMMARY_PART_ADDED, { item_id: reasoningId, output_index: outputIndex, summary_index: 0, part: { type: PART.SUMMARY_TEXT, text: "" } });
    }

    /** Emit a finished output item and record it for the terminal snapshot. */
    function* itemDone(index: number, item: Record<string, unknown>): Generator<string> {
      yield frame(EVENT.OUTPUT_ITEM_DONE, { output_index: index, item });
      output.push(item);
    }

    function* closeReasoning(): Generator<string> {
      if (reasoningText == null) return;
      const item = { id: reasoningId, type: ITEM.REASONING, ...reasoningItemBody(reasoningText, reasoningSignature) };
      if (reasoningText) {
        yield frame(EVENT.REASONING_SUMMARY_TEXT_DONE, { item_id: reasoningId, output_index: outputIndex, summary_index: 0, text: reasoningText });
        yield frame(EVENT.REASONING_SUMMARY_PART_DONE, { item_id: reasoningId, output_index: outputIndex, summary_index: 0, part: { type: PART.SUMMARY_TEXT, text: reasoningText } });
      }
      yield* itemDone(outputIndex++, item);
      reasoningText = null;
      reasoningSignature = undefined;
    }

    function* closeMessage(): Generator<string> {
      if (msgText == null) return;
      const part = { type: PART.OUTPUT_TEXT, text: msgText, annotations: [] };
      const item = { id: msgId, type: ITEM.MESSAGE, status: RESPONSE_STATUS.COMPLETED, role: ROLE.ASSISTANT, content: [part] };
      yield frame(EVENT.OUTPUT_TEXT_DONE, { item_id: msgId, output_index: outputIndex, content_index: 0, text: msgText });
      yield frame(EVENT.CONTENT_PART_DONE, { item_id: msgId, output_index: outputIndex, content_index: 0, part });
      yield* itemDone(outputIndex++, item);
      msgText = null;
    }

    type OpenTool = { itemId: string; callId: string; name: string; args: string; index: number };
    function* closeTool(tc: OpenTool): Generator<string> {
      const item = { id: tc.itemId, type: ITEM.FUNCTION_CALL, status: RESPONSE_STATUS.COMPLETED, call_id: tc.callId, name: tc.name, arguments: tc.args };
      yield frame(EVENT.FUNCTION_CALL_ARGUMENTS_DONE, { item_id: tc.itemId, output_index: tc.index, arguments: tc.args });
      yield* itemDone(tc.index, item);
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
          yield frame(RESPONSE_EVENT.CREATED, { response: response(RESPONSE_STATUS.IN_PROGRESS) });
          yield frame(RESPONSE_EVENT.IN_PROGRESS, { response: response(RESPONSE_STATUS.IN_PROGRESS) });
          break;
        case "reasoning_start":
          yield* closeMessage();
          yield* closeReasoning();
          if (ev.redacted) {
            redactedItemId = ev.id || genId(ID_PREFIX.REASONING);
            yield frame(EVENT.OUTPUT_ITEM_ADDED, {
              output_index: outputIndex,
              item: { id: redactedItemId, type: ITEM.REASONING, summary: [] },
            });
            break;
          }
          yield* openReasoning(ev.id);
          break;
        case "reasoning_delta":
          if (redactedItemId) break; // a redacted block streams no text
          if (reasoningText == null) {
            yield* closeMessage();
            yield* openReasoning();
          }
          reasoningText = (reasoningText ?? "") + ev.text;
          yield frame(EVENT.REASONING_SUMMARY_TEXT_DELTA, { item_id: reasoningId, output_index: outputIndex, summary_index: 0, delta: ev.text });
          break;
        case "reasoning_stop":
          if (redactedItemId || ev.redacted) {
            const id = redactedItemId ?? ev.id ?? genId(ID_PREFIX.REASONING);
            const envelope = encodeRedacted({ type: "reasoning", text: "", redacted: true, signature: ev.signature });
            yield* itemDone(outputIndex++, { id, type: ITEM.REASONING, ...reasoningItemBody("", envelope) });
            redactedItemId = null;
            break;
          }
          if (reasoningText == null) {
            yield* closeMessage();
            yield* openReasoning(ev.id);
          }
          reasoningSignature = clientSignature({ type: "reasoning", text: reasoningText ?? "", signature: ev.signature, origin: ev.origin, itemId: ev.id }, "openai_responses");
          yield* closeReasoning();
          break;
        case "text_delta":
          if (msgText == null) {
            yield* closeReasoning();
            msgId = genId(ID_PREFIX.MESSAGE);
            msgText = "";
            yield frame(EVENT.OUTPUT_ITEM_ADDED, { output_index: outputIndex, item: { id: msgId, type: ITEM.MESSAGE, status: RESPONSE_STATUS.IN_PROGRESS, role: ROLE.ASSISTANT, content: [] } });
            yield frame(EVENT.CONTENT_PART_ADDED, { item_id: msgId, output_index: outputIndex, content_index: 0, part: { type: PART.OUTPUT_TEXT, text: "", annotations: [] } });
          }
          msgText += ev.text;
          yield frame(EVENT.OUTPUT_TEXT_DELTA, { item_id: msgId, output_index: outputIndex, content_index: 0, delta: ev.text });
          break;
        case "tool_start": {
          yield* closeReasoning();
          yield* closeMessage();
          const tc = { itemId: genId(ID_PREFIX.FUNCTION_CALL), callId: ev.id, name: ev.name, args: "", index: outputIndex };
          tools.set(ev.index, tc);
          outputIndex++;
          yield frame(EVENT.OUTPUT_ITEM_ADDED, { output_index: tc.index, item: { id: tc.itemId, type: ITEM.FUNCTION_CALL, status: RESPONSE_STATUS.IN_PROGRESS, call_id: tc.callId, name: tc.name, arguments: "" } });
          break;
        }
        case "tool_args_delta": {
          const tc = tools.get(ev.index);
          if (tc) {
            tc.args += ev.delta;
            yield frame(EVENT.FUNCTION_CALL_ARGUMENTS_DELTA, { item_id: tc.itemId, output_index: tc.index, delta: ev.delta });
          }
          break;
        }
        // A provider-executed round trip is ONE item on this wire. The call and
        // its result arrive together, so the item is emitted whole once the
        // result is known — there is no client-side execution to open first.
        case "server_tool_start":
          serverInputs.set(ev.id, ev.input);
          break;
        case "server_tool_result": {
          yield* closeReasoning();
          yield* closeMessage();
          const item = renderSearchCall({ type: "server_tool_result", family: ev.family ?? "openai_responses", id: ev.id, name: ev.name,
            input: serverInputs.get(ev.id), blockType: ev.blockType, content: ev.content, errorCode: ev.errorCode, notExecuted: ev.notExecuted });
          serverInputs.delete(ev.id);
          const index = outputIndex++;
          yield frame(EVENT.OUTPUT_ITEM_ADDED, { output_index: index, item: { ...item, status: RESPONSE_STATUS.IN_PROGRESS } });
          yield* itemDone(index, item);
          break;
        }
        case "tool_stop": {
          const tc = tools.get(ev.index);
          if (tc) {
            tools.delete(ev.index);
            yield* closeTool(tc);
          }
          break;
        }
        case "finish": {
          // A truncated upstream must not be dressed up as a finished answer:
          // no response.completed. relay() aborts the connection instead.
          if (ev.incomplete || ev.error) return;
          yield* closeReasoning();
          yield* closeMessage();
          for (const tc of tools.values()) yield* closeTool(tc);
          tools.clear();
          for (const [id, input] of serverInputs) {
            const item = pendingSearchCall(id, WEB_SEARCH_TOOL_NAME, input);
            const index = outputIndex++;
            yield frame(EVENT.OUTPUT_ITEM_ADDED, { output_index: index, item });
            yield* itemDone(index, item);
          }
          serverInputs.clear();
          const { status, incompleteDetails } = stopToResponsesStatus(ev.stopReason);
          yield frame(status === RESPONSE_STATUS.INCOMPLETE ? RESPONSE_EVENT.INCOMPLETE : RESPONSE_EVENT.COMPLETED, {
            response: response(status, {
              output,
              ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
              ...(ev.usage ? { usage: openAiUsageToWire(ev.usage, USAGE_KEYS) } : {}),
            }),
          });
          break;
        }
      }
    }
  }
}

registerFormat("openai_responses", { request: OpenAIResponsesRequest, response: OpenAIResponsesResponse });
