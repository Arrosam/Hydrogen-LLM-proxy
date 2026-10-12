/** Small wire-format coercion helpers shared by the format subclasses. */

import { DEFAULT_FILE_MEDIA_TYPE, type ContentPart, type FileSource, type ImagePart } from "../ir/content";
import type { Family, GenerationParams, ResponseFormat } from "../ir/params";
import type { Usage } from "../ir/usage";
import { FILE_ID_SCOPE_NOTE, FormatConversionError } from "./errors";
import { num, numOrUndef } from "../ir/coerce";

/** `name` an OpenAI json_schema format is given when the request named none. */
export const DEFAULT_JSON_SCHEMA_NAME = "schema";

/**
 * The cache-hit count out of an OpenAI-shaped `usage` object, whatever the
 * provider decided to call it.
 *
 * `prompt_tokens_details.cached_tokens` is the spelling OpenAI itself uses and
 * the one the official-compatible gateways copy. It is not the only one on the
 * wire: DeepSeek reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * alongside a `prompt_tokens` that already sums them, and several gateways put
 * a bare `cached_tokens` at the top level. Reading only the first spelling
 * means every one of those upstreams reports no cache at all -- which reaches
 * the client as a flat 0% hit rate on a cache that is in fact working.
 *
 * All spellings are the same quantity in the same convention (a SUBSET of the
 * prompt count), so the first one present wins and nothing is summed.
 */
export function openAiCachedTokens(usage: Record<string, unknown>): number | undefined {
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details ?? {}) as Record<string, unknown>;
  return numOrUndef(details.cached_tokens)
    ?? numOrUndef(usage.prompt_cache_hit_tokens)
    ?? numOrUndef(usage.cached_tokens);
}

/** Where an OpenAI-shaped `usage` object keeps its counters; the two OpenAI wires differ only in these names. */
export interface OpenAiUsageKeys {
  prompt: string;
  completion: string;
  promptDetails: string;
  completionDetails: string;
}

/**
 * Canonical usage from a complete OpenAI-shaped `usage` object.
 *
 * `zeroTotalIsMissing` is how a reported `total_tokens` of 0 is read: as the
 * total (false), or as "not reported", falling back to prompt + completion
 * (true). The buffered parsers do the former and the Responses stream parser
 * the latter; the difference is kept as it was.
 */
export function parseOpenAiUsage(usage: Record<string, unknown>, keys: OpenAiUsageKeys, opts: { zeroTotalIsMissing?: boolean } = {}): Usage {
  const promptTokens = num(usage[keys.prompt]);
  const completionTokens = num(usage[keys.completion]);
  const cachedInputTokens = openAiCachedTokens(usage);
  const reasoningTokens = numOrUndef(((usage[keys.completionDetails] ?? {}) as Record<string, unknown>).reasoning_tokens);
  const total = opts.zeroTotalIsMissing ? num(usage.total_tokens) || undefined : numOrUndef(usage.total_tokens);
  return {
    promptTokens, completionTokens, totalTokens: total ?? promptTokens + completionTokens,
    ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
    ...(reasoningTokens != null ? { reasoningTokens } : {}),
  };
}

/** Canonical usage as an OpenAI-shaped `usage` object, buffered or streamed. */
export function openAiUsageToWire(u: Usage, keys: OpenAiUsageKeys): Record<string, unknown> {
  return {
    [keys.prompt]: u.promptTokens, [keys.completion]: u.completionTokens, total_tokens: u.totalTokens,
    ...(u.cachedInputTokens != null ? { [keys.promptDetails]: { cached_tokens: u.cachedInputTokens } } : {}),
    ...(u.reasoningTokens != null ? { [keys.completionDetails]: { reasoning_tokens: u.reasoningTokens } } : {}),
  };
}

/** Parse a stop/stop_sequences field (string or array) into a string[]. */
export function parseStop(v: unknown): string[] | undefined {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.map(String);
  return undefined;
}

/** Split an image URL into an image source (data: URLs become base64). */
export function parseDataUrl(url: string): ImagePart["source"] {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (m) return { kind: "base64", mediaType: m[1], data: m[2] };
  return { kind: "url", url };
}

/** Inline bytes as a base64 data URL. */
export function dataUrlOf(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

/** Build a displayable image URL from an image source. */
export function imageUrlOf(source: ImagePart["source"]): string {
  return source.kind === "base64" ? dataUrlOf(source.mediaType, source.data) : source.url;
}

/** The URL of an OpenAI image part's `image_url`, which is a string or `{ url }`. */
export function imageUrlField(image: unknown): string {
  return typeof image === "string" ? image : String((image as Record<string, unknown> | null | undefined)?.url ?? "");
}

/** An OpenAI `file_data` value as a file source: a base64 data URL, or bare base64 taken to be a PDF. */
export function parseInlineFileData(data: string): FileSource {
  const src = data.startsWith("data:") ? parseDataUrl(data) : { kind: "base64" as const, mediaType: DEFAULT_FILE_MEDIA_TYPE, data };
  return src.kind === "url" ? src : { kind: "base64", mediaType: src.mediaType, data: src.data };
}

/**
 * The refusal every adapter raises for a file id minted by another family: id
 * spaces do not overlap, so forwarding one either 404s upstream or resolves to
 * an unrelated document. `provider` names the egress in the message.
 */
export function foreignFileIdError(source: Extract<FileSource, { kind: "file_id" }>, provider: string): FormatConversionError {
  return new FormatConversionError(`cannot send a ${source.family} file_id ("${source.id}") to ${provider} provider: ${FILE_ID_SCOPE_NOTE}`);
}

/** The object entries of a wire array; anything else in it (and a non-array) is skipped. */
export function* objectsIn(list: unknown): Generator<Record<string, unknown>> {
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    if (entry && typeof entry === "object") yield entry as Record<string, unknown>;
  }
}

/** A message `content` given as a bare string, as parts; undefined when it is not a string. */
export function stringContentParts(content: unknown): ContentPart[] | undefined {
  if (typeof content !== "string") return undefined;
  return content ? [{ type: "text", text: content }] : [];
}

/** Message roles as the two OpenAI wires spell them (`tool` exists on Chat Completions only). */
/**
 * Text of the user message that carries a tool result's images on the two
 * OpenAI wires, whose tool-result carriers (the `tool` role, a
 * `function_call_output` item) are text-only.
 */
export const TOOL_RESULT_IMAGES_NOTE = "(images returned by the tool results above)";

export const OPENAI_ROLE = {
  SYSTEM: "system",
  DEVELOPER: "developer",
  USER: "user",
  ASSISTANT: "assistant",
  TOOL: "tool",
} as const;

/** `response_format.type` / `text.format.type` values of the two OpenAI wires. */
export const OPENAI_RESPONSE_FORMAT = {
  TEXT: "text",
  JSON_OBJECT: "json_object",
  JSON_SCHEMA: "json_schema",
} as const;

/**
 * Parse an OpenAI structured-output format object. `schemaFields` says where
 * the json_schema's name / schema / strict live: nested under `json_schema` on
 * Chat Completions, on the format object itself on Responses.
 */
export function parseOpenAiResponseFormat(
  raw: unknown,
  schemaFields: (format: Record<string, unknown>) => Record<string, unknown>,
): ResponseFormat | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const format = raw as Record<string, unknown>;
  if (format.type === OPENAI_RESPONSE_FORMAT.TEXT) return { type: "text" };
  if (format.type === OPENAI_RESPONSE_FORMAT.JSON_OBJECT) return { type: "json_object" };
  if (format.type === OPENAI_RESPONSE_FORMAT.JSON_SCHEMA) {
    const js = schemaFields(format);
    return {
      type: "json_schema",
      name: js.name ? String(js.name) : undefined,
      schema: (js.schema as Record<string, unknown>) ?? {},
      strict: typeof js.strict === "boolean" ? js.strict : undefined,
    };
  }
  return undefined;
}

/** The name / schema / strict fields of a json_schema format, as both OpenAI wires spell them. */
export function openAiJsonSchemaFields(rf: Extract<ResponseFormat, { type: "json_schema" }>): Record<string, unknown> {
  return { name: rf.name ?? DEFAULT_JSON_SCHEMA_NAME, schema: rf.schema, ...(rf.strict != null ? { strict: rf.strict } : {}) };
}

/** True when an OpenAI-family client named a prompt-cache tuning param: its way of saying the conversation repeats. */
export function hasCacheHint(body: Record<string, unknown>): boolean {
  return body.prompt_cache_key != null || body.prompt_cache_options != null;
}

/** A setter that writes only defined values onto `params` -- an absent wire field stays an absent canonical one. */
export function paramSetter(params: GenerationParams): <K extends keyof GenerationParams>(key: K, value: GenerationParams[K] | undefined) => void {
  return (key, value) => {
    if (value !== undefined) params[key] = value;
  };
}

/**
 * Collect the body keys a format's parser and renderer don't own. Everything a
 * format models canonically is listed in its `reserved` set; whatever is left is
 * a param this proxy has no opinion about, and dropping it would silently change
 * the request the client actually made.
 */
export function collectPassthrough(
  body: Record<string, unknown>,
  reserved: ReadonlySet<string>,
  family: Family,
): GenerationParams["passthrough"] {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (reserved.has(k) || v === undefined) continue;
    params[k] = v;
  }
  return Object.keys(params).length ? { family, params } : undefined;
}

/**
 * Merge the non-canonical params onto an outgoing body, weakest first: the
 * client's own unrecognized params, then the step/stage `extra` override.
 *
 * Client passthrough only replays onto its own family — an OpenAI-only knob is
 * meaningless on an Anthropic body, and sending it there gets the request
 * rejected. It also never overwrites a key the renderer already decided, so a
 * translated or overridden value always beats a leftover.
 */
export function applyNonCanonical(out: Record<string, unknown>, p: GenerationParams, family: Family): void {
  if (p.passthrough && p.passthrough.family === family) {
    for (const [k, v] of Object.entries(p.passthrough.params)) {
      if (!(k in out)) out[k] = v;
    }
  }
  if (p.extra) Object.assign(out, p.extra);
}
