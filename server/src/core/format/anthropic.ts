import { Request, type RenderTarget } from "../ir/request";
import { Response } from "../ir/response";
import {
  normalizeMessages,
  orderReasoningFirst,
  type ContentPart,
  type FileSource,
  type ImagePart,
  type Message,
  type StopReason,
  type TextPart,
  type Tool,
  type ToolChoice,
} from "../ir/content";
import type { GenerationParams, ThinkingLevel } from "../ir/params";
import { ThinkingPolicy } from "../ir/thinking";
import { parseSSE, safeParseJson, type StreamContext, type StreamEvent } from "../ir/stream";
import { genId, nowSeconds } from "../../util/ids";
import { applyNonCanonical, collectPassthrough, num, numOrUndef } from "./wire";
import { FormatConversionError } from "./errors";
import { registerFormat } from "./registry";
import type { SendTarget, Transport } from "../upstream/transport";
import type { RelayResult, SendResult } from "../upstream/outcome";
import { relayStream, sendBuffered } from "../upstream/roundtrip";

// --- stop reason mapping -------------------------------------------------

function stopReasonToStop(reason: string | null | undefined): StopReason {
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

function stopToAnthropic(reason: StopReason): string {
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

// --- block <-> part coercion ---------------------------------------------

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

function parseImageSource(source: unknown): ImagePart["source"] {
  const s = (source ?? {}) as Record<string, unknown>;
  if (s.type === "url") return { kind: "url", url: String(s.url ?? "") };
  return { kind: "base64", mediaType: String(s.media_type ?? "image/png"), data: String(s.data ?? "") };
}

function imageSourceToBlock(source: ImagePart["source"]): unknown {
  if (source.kind === "url") return { type: "url", url: source.url };
  return { type: "base64", media_type: source.mediaType, data: source.data };
}

function blocksToParts(content: unknown): ContentPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    const cc = b.cache_control != null ? { cacheControl: b.cache_control } : {};
    switch (b.type) {
      case "thinking":
        parts.push({ type: "reasoning", text: String(b.thinking ?? ""), signature: b.signature != null ? String(b.signature) : undefined });
        break;
      case "redacted_thinking":
        // Opaque bytes; only a same-family replay can restore them. Never
        // rewrite the text -- a signature over altered text can never verify.
        parts.push({ type: "reasoning", text: "", redacted: true, signature: b.data != null ? String(b.data) : undefined });
        break;
      case "text":
        parts.push({ type: "text", text: String(b.text ?? ""), ...cc });
        break;
      case "image":
        parts.push({ type: "image", source: parseImageSource(b.source), ...cc });
        break;
      case "document": {
        const src = (b.source ?? {}) as Record<string, unknown>;
        const title = b.title != null ? String(b.title) : undefined;
        if (src.type === "url") parts.push({ type: "file", source: { kind: "url", url: String(src.url ?? "") }, name: title, ...cc });
        else if (src.type === "text") parts.push({ type: "text", text: String(src.data ?? ""), ...cc });
        // A handle into Anthropic's own Files API. Kept like the other families'
        // ids: replayed verbatim here, and refused loudly elsewhere rather than
        // dropped, which would send the prompt on without its attachment.
        else if (src.type === "file" && typeof src.file_id === "string" && src.file_id) {
          parts.push({ type: "file", source: { kind: "file_id", id: src.file_id, family: "anthropic" }, name: title, ...cc });
        }
        else if (src.data != null) parts.push({ type: "file", source: { kind: "base64", mediaType: String(src.media_type ?? "application/pdf"), data: String(src.data) }, name: title, ...cc });
        break;
      }
      case "tool_use":
        parts.push({ type: "tool_use", id: String(b.id ?? genId("toolu")), name: String(b.name ?? ""), input: b.input ?? {}, ...cc });
        break;
      case "tool_result":
        parts.push({
          type: "tool_result",
          toolUseId: String(b.tool_use_id ?? ""),
          content: blocksToParts(b.content).filter((p): p is TextPart | ImagePart => p.type === "text" || p.type === "image"),
          isError: b.is_error === true ? true : undefined,
          ...cc,
        });
        break;
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
      return { type: "url", url: source.url };
    case "base64":
      return { type: "base64", media_type: source.mediaType, data: source.data };
    case "file_id":
      if (source.family === "anthropic") return { type: "file", file_id: source.id };
      throw new FormatConversionError(
        `cannot send a ${source.family} file_id ("${source.id}") to an Anthropic provider: ` +
          `a file id only resolves in the API that issued it`,
      );
  }
}

function partsToBlocks(parts: ContentPart[]): unknown[] {
  const blocks: unknown[] = [];
  const cc = (part: { cacheControl?: unknown }): Record<string, unknown> =>
    part.cacheControl != null ? { cache_control: part.cacheControl } : {};
  for (const p of parts) {
    switch (p.type) {
      case "text":
        blocks.push({ type: "text", text: p.text, ...cc(p) });
        break;
      case "reasoning":
        if (p.redacted) blocks.push({ type: "redacted_thinking", data: p.signature ?? "" });
        else blocks.push({ type: "thinking", thinking: p.text, ...(p.signature ? { signature: p.signature } : {}) });
        break;
      case "image":
        blocks.push({ type: "image", source: imageSourceToBlock(p.source), ...cc(p) });
        break;
      case "file":
        blocks.push({
          type: "document",
          source: documentSource(p.source),
          ...(p.name ? { title: p.name } : {}),
          ...cc(p),
        });
        break;
      case "opaque":
        break; // another family's private part; nothing Anthropic can carry
      case "tool_use":
        blocks.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {}, ...cc(p) });
        break;
      case "tool_result":
        blocks.push({ type: "tool_result", tool_use_id: p.toolUseId, content: partsToBlocks(p.content), ...(p.isError ? { is_error: true } : {}), ...cc(p) });
        break;
    }
  }
  return blocks;
}

// --- tools ---------------------------------------------------------------

function parseTools(raw: unknown): Tool[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: Tool[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const tool = t as Record<string, unknown>;
    // A server-side tool (web_search_20250305, bash, computer use, ...) has a
    // `type` and no input_schema: keep it verbatim for same-family replay
    // instead of mangling it into an empty-schema client tool.
    if (tool.type && tool.input_schema == null) {
      tools.push({ name: String(tool.name ?? tool.type), parameters: {}, raw: { family: "anthropic", value: t } });
      continue;
    }
    if (!tool.name) continue;
    tools.push({
      name: String(tool.name),
      description: tool.description ? String(tool.description) : undefined,
      parameters: (tool.input_schema as Record<string, unknown>) ?? { type: "object", properties: {} },
      ...(tool.cache_control != null ? { cacheControl: tool.cache_control } : {}),
    });
  }
  return tools.length ? tools : undefined;
}

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

function toolChoiceToAnthropic(choice: ToolChoice): unknown {
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

// --- thinking / params ---------------------------------------------------

function parseThinking(body: Record<string, unknown>): ThinkingLevel | undefined {
  // `output_config.effort` outranks the on/off flag: saying how much to think
  // already says that it should. It stays OUT of RESERVED on purpose -- the rest
  // of `output_config` (structured outputs) has to keep riding the passthrough,
  // and the renderer merges the effort back into whatever the client sent.
  const oc = body.output_config;
  if (oc && typeof oc === "object" && !Array.isArray(oc)) {
    const effort = (oc as Record<string, unknown>).effort;
    if (effort === "minimal" || effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") {
      return effort;
    }
  }
  const t = body.thinking;
  if (!t || typeof t !== "object") return undefined;
  const cfg = t as Record<string, unknown>;
  // `adaptive` is the current on-switch and the one modern clients send; reading
  // only `enabled` meant an adaptive request looked like "said nothing", and on a
  // model where an absent `thinking` means no thinking that silently turned it off.
  if (cfg.type === "adaptive") return "enabled";
  if (cfg.type === "enabled") {
    const budget = numOrUndef(cfg.budget_tokens);
    return budget != null ? { budget } : "enabled";
  }
  if (cfg.type === "disabled") return "disabled";
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
  if (numOrUndef(body.temperature) != null) params.temperature = numOrUndef(body.temperature);
  if (numOrUndef(body.top_p) != null) params.topP = numOrUndef(body.top_p);
  if (numOrUndef(body.top_k) != null) params.topK = numOrUndef(body.top_k);
  if (numOrUndef(body.max_tokens) != null) params.maxTokens = numOrUndef(body.max_tokens);
  if (Array.isArray(body.stop_sequences)) params.stop = body.stop_sequences.map(String);
  const disableParallel = parseDisableParallel(body.tool_choice);
  if (disableParallel != null) params.parallelToolCalls = !disableParallel;
  // metadata.user_id is this wire's spelling of OpenAI's `user`; translate it so
  // it survives a cross-family hop (same-family metadata still rides passthrough).
  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta.user_id === "string" && meta.user_id) params.user = meta.user_id;
  const thinking = parseThinking(body);
  if (thinking) params.thinking = thinking;
  // `metadata` (and any other unmodeled key) rides the family-scoped passthrough,
  // not `extra`: it is an Anthropic-shaped field, so it must reach only Anthropic
  // providers -- `extra` applies to every family and would leak it to OpenAI.
  const passthrough = collectPassthrough(body, RESERVED, "anthropic");
  if (passthrough) params.passthrough = passthrough;
  return params;
}

export class AnthropicRequest extends Request {
  readonly family = "anthropic" as const;

  static parse(body: Record<string, unknown>): AnthropicRequest {
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages: Message[] = [];
    for (const raw of rawMessages) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const role = m.role === "assistant" ? "assistant" : "user";
      messages.push({ role, content: blocksToParts(m.content) });
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
      tools: parseTools(body.tools),
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
        if (b.type === "thinking" || b.type === "redacted_thinking") continue;
        b.cache_control = { type: "ephemeral", ...((p.cacheTtlMinutes ?? 30) > 5 ? { ttl: "1h" } : {}) };
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
    if (this.tools) {
      // Same-family server tools replay verbatim; another family's are dropped
      // (they cannot be expressed here) rather than sent as empty client tools.
      const rendered = this.tools
        .filter((t) => !t.raw || t.raw.family === "anthropic")
        .map((t) => (t.raw ? t.raw.value : { name: t.name, description: t.description, input_schema: t.parameters, ...(t.cacheControl != null ? { cache_control: t.cacheControl } : {}) }));
      if (rendered.length) out.tools = rendered;
    }
    if (this.toolChoice) out.tool_choice = toolChoiceToAnthropic(this.toolChoice);
    // OpenAI's parallel_tool_calls=false translates to this wire's
    // tool_choice.disable_parallel_tool_use (tool_choice defaults to auto).
    if (p.parallelToolCalls === false) {
      const tc = (out.tool_choice ?? { type: "auto" }) as Record<string, unknown>;
      if (tc.type === "auto" || tc.type === "any" || tc.type === "tool") out.tool_choice = { ...tc, disable_parallel_tool_use: true };
    }
    // Anthropic's sampling ranges are narrower than OpenAI's (temperature 0..1
    // vs 0..2); clamp instead of letting the upstream 400 the whole request.
    if (p.temperature != null) out.temperature = Math.min(Math.max(p.temperature, 0), 1);
    if (p.topP != null) out.top_p = Math.min(Math.max(p.topP, 0), 1);
    if (p.topK != null) out.top_k = p.topK;
    if (p.stop && p.stop.length) out.stop_sequences = p.stop;
    if (this.stream) out.stream = true;
    // This family has no response_format; a JSON contract silently vanishing is
    // worse than a blunt instruction, so say it in the system prompt.
    if (p.responseFormat && p.responseFormat.type !== "text") {
      const schema = p.responseFormat.type === "json_schema" ? ` matching this JSON Schema: ${JSON.stringify(p.responseFormat.schema)}` : "";
      const jsonNote = `Respond ONLY with a valid JSON object${schema}. No prose, no markdown fences.`;
      out.system = this.system ? `${this.system}\n\n${jsonNote}` : jsonNote;
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
    // The policy still owns max_tokens: it fits any budget under the client's
    // requested max and the provider's hard cap, still prefers that cap over the
    // built-in fallback when the client never budgeted, and floors the result at
    // 1 (max_tokens is required here, and 0 is not a valid request).
    const tf = ThinkingPolicy.anthropic(p.thinking ?? "disabled", p.maxTokens, cap);
    if (p.thinking != null) {
      out.thinking = tf.thinking;
      if (tf.effort) {
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
    out.max_tokens = tf.max_tokens;
    applyNonCanonical(out, p, this.family);
    // OpenAI's `user` abuse-tracking id maps to metadata.user_id; a client's own
    // passthrough metadata (same family) wins.
    if (p.user) {
      const meta = (out.metadata ?? {}) as Record<string, unknown>;
      if (meta.user_id == null) out.metadata = { ...meta, user_id: p.user };
    }
    return out;
  }

  /** Rebuild any canonical Request as an Anthropic Messages request. */
  static construct(base: Request): AnthropicRequest {
    return new AnthropicRequest(base.data());
  }

  send(transport: Transport, target: SendTarget): Promise<SendResult> {
    return sendBuffered(this, transport, target);
  }

  relay(transport: Transport, target: SendTarget): Promise<RelayResult> {
    return relayStream(this, transport, target);
  }
}

export class AnthropicResponse extends Response {
  readonly family = "anthropic" as const;

  static parse(body: Record<string, unknown>): AnthropicResponse {
    const content = blocksToParts(body.content).filter(
      (p) => p.type === "text" || p.type === "tool_use" || p.type === "reasoning",
    );
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    const promptTokens = numOrUndef(usage.input_tokens) ?? 0;
    const completionTokens = numOrUndef(usage.output_tokens) ?? 0;
    const cachedInputTokens = numOrUndef(usage.cache_read_input_tokens);
    const cacheCreationInputTokens = numOrUndef(usage.cache_creation_input_tokens);
    return new AnthropicResponse({
      id: String(body.id ?? genId("msg")),
      model: String(body.model ?? ""),
      created: nowSeconds(),
      content,
      stopReason: stopReasonToStop(body.stop_reason as string | null),
      usage: {
        promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
        ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
        ...(cacheCreationInputTokens != null ? { cacheCreationInputTokens } : {}),
      },
    });
  }

  renderSelf(model: string): Record<string, unknown> {
    const content: unknown[] = [];
    for (const p of this.content) {
      if (p.type === "reasoning") {
        if (p.redacted) content.push({ type: "redacted_thinking", data: p.signature ?? "" });
        else content.push({ type: "thinking", thinking: p.text, ...(p.signature ? { signature: p.signature } : {}) });
      }
      else if (p.type === "text") content.push({ type: "text", text: p.text });
      else if (p.type === "tool_use") content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    return {
      id: this.id,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stopToAnthropic(this.stopReason),
      stop_sequence: null,
      usage: {
        input_tokens: this.usage.promptTokens, output_tokens: this.usage.completionTokens,
        ...(this.usage.cachedInputTokens != null ? { cache_read_input_tokens: this.usage.cachedInputTokens } : {}),
        ...(this.usage.cacheCreationInputTokens != null ? { cache_creation_input_tokens: this.usage.cacheCreationInputTokens } : {}),
      },
    };
  }

  static async *parseStream(readable: AsyncIterable<Buffer | string>): AsyncGenerator<StreamEvent> {
    let stopReason: StopReason = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens: number | undefined;
    // Cache WRITES are reported here too, and were the one usage field the
    // streaming path dropped while the buffered path kept it -- so the same
    // request billed a cache write invisibly when it streamed.
    let cacheCreationInputTokens: number | undefined;
    const toolBlocks = new Set<number>();
    // Thinking blocks stream their signature in a trailing signature_delta;
    // hold it per block and attach it to the reasoning_stop. A redacted block is
    // the exception: its opaque bytes arrive whole in content_block_start.data
    // and no delta of any kind follows, so the payload is captured there.
    const thinkingBlocks = new Map<number, { signature?: string; redacted?: boolean }>();

    for await (const frame of parseSSE(readable)) {
      const data = safeParseJson(frame.data);
      if (!data) continue;
      const type = frame.event ?? String(data.type ?? "");

      switch (type) {
        case "message_start": {
          const message = (data.message ?? {}) as Record<string, unknown>;
          const usage = (message.usage ?? {}) as Record<string, unknown>;
          inputTokens = num(usage.input_tokens);
          if (numOrUndef(usage.cache_read_input_tokens) != null) cachedInputTokens = num(usage.cache_read_input_tokens);
          if (numOrUndef(usage.cache_creation_input_tokens) != null) cacheCreationInputTokens = num(usage.cache_creation_input_tokens);
          yield { type: "start", id: String(message.id ?? genId("msg")), model: String(message.model ?? ""), created: nowSeconds(), inputTokens };
          break;
        }
        case "content_block_start": {
          const index = num(data.index);
          const block = (data.content_block ?? {}) as Record<string, unknown>;
          if (block.type === "tool_use") {
            toolBlocks.add(index);
            yield { type: "tool_start", index, id: String(block.id ?? genId("toolu")), name: String(block.name ?? "") };
          } else if (block.type === "thinking" || block.type === "redacted_thinking") {
            const redacted = block.type === "redacted_thinking";
            const data = redacted && typeof block.data === "string" && block.data ? block.data : undefined;
            thinkingBlocks.set(index, { signature: data, redacted });
            yield { type: "reasoning_start", ...(redacted ? { redacted: true, signature: data } : {}) };
          }
          break;
        }
        case "content_block_delta": {
          const index = num(data.index);
          const delta = (data.delta ?? {}) as Record<string, unknown>;
          if (delta.type === "text_delta" && typeof delta.text === "string") yield { type: "text_delta", text: delta.text };
          else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") yield { type: "reasoning_delta", text: delta.thinking };
          else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
            const tb = thinkingBlocks.get(index);
            if (tb) tb.signature = (tb.signature ?? "") + delta.signature;
          }
          else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") yield { type: "tool_args_delta", index, delta: delta.partial_json };
          break;
        }
        case "content_block_stop": {
          const index = num(data.index);
          if (toolBlocks.has(index)) {
            toolBlocks.delete(index);
            yield { type: "tool_stop", index };
          } else if (thinkingBlocks.has(index)) {
            const tb = thinkingBlocks.get(index)!;
            thinkingBlocks.delete(index);
            yield { type: "reasoning_stop", signature: tb.signature, ...(tb.redacted ? { redacted: true } : {}) };
          }
          break;
        }
        case "message_delta": {
          const delta = (data.delta ?? {}) as Record<string, unknown>;
          if (delta.stop_reason) stopReason = stopReasonToStop(delta.stop_reason as string);
          const usage = (data.usage ?? {}) as Record<string, unknown>;
          if (usage.output_tokens != null) outputTokens = num(usage.output_tokens);
          // Some providers report the real prompt count -- and the cache
          // counters -- only here, at the end.
          if (num(usage.input_tokens) > 0) inputTokens = num(usage.input_tokens);
          if (numOrUndef(usage.cache_read_input_tokens) != null) cachedInputTokens = num(usage.cache_read_input_tokens);
          if (numOrUndef(usage.cache_creation_input_tokens) != null) cacheCreationInputTokens = num(usage.cache_creation_input_tokens);
          break;
        }
        case "message_stop": {
          const stopUsage = (data.usage ?? {}) as Record<string, unknown>;
          if (num(stopUsage.output_tokens) > 0) outputTokens = num(stopUsage.output_tokens);
          if (num(stopUsage.input_tokens) > 0) inputTokens = num(stopUsage.input_tokens);
          yield {
            type: "finish",
            stopReason,
            usage: {
              promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens,
              ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
              ...(cacheCreationInputTokens != null ? { cacheCreationInputTokens } : {}),
            },
          };
          return;
        }
        default:
          break;
      }
    }
    // Reached only when the stream ended without a message_stop -- truncated.
    yield { type: "finish", stopReason, usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens }, incomplete: true };
  }

  static async *serializeStream(events: AsyncGenerator<StreamEvent>, ctx: StreamContext): AsyncGenerator<string> {
    let id = genId("msg");
    const model = ctx.model;
    let inputTokens = 0;
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
    const toolMap = new Map<number, number>();

    const frame = (event: string, data: Record<string, unknown>): string =>
      `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

    for await (const ev of events) {
      switch (ev.type) {
        case "start":
          id = ev.id || id;
          inputTokens = ev.inputTokens ?? 0;
          yield frame("message_start", {
            message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } },
          });
          break;
        case "text_delta":
          if (!textOpen) {
            if (reasoningOpen) {
              yield frame("content_block_stop", { index: reasoningIndex });
              reasoningOpen = false;
            }
            textIndex = nextIndex++;
            textOpen = true;
            yield frame("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } });
          }
          yield frame("content_block_delta", { index: textIndex, delta: { type: "text_delta", text: ev.text } });
          break;
        case "reasoning_start":
          if (!reasoningOpen) {
            reasoningIndex = nextIndex++;
            reasoningOpen = true;
            reasoningRedacted = ev.redacted === true;
            yield frame("content_block_start", {
              index: reasoningIndex,
              content_block: reasoningRedacted
                ? { type: "redacted_thinking", data: ev.signature ?? "" }
                : { type: "thinking", thinking: "" },
            });
          }
          break;
        case "reasoning_delta":
          if (!reasoningOpen) {
            reasoningIndex = nextIndex++;
            reasoningOpen = true;
            reasoningRedacted = false;
            yield frame("content_block_start", { index: reasoningIndex, content_block: { type: "thinking", thinking: "" } });
          }
          // A redacted block has no readable thinking to delta; the wire form
          // carries everything it has on the block itself.
          if (!reasoningRedacted) {
            yield frame("content_block_delta", { index: reasoningIndex, delta: { type: "thinking_delta", thinking: ev.text } });
          }
          break;
        case "reasoning_stop":
          if (reasoningOpen) {
            // signature_delta belongs to a thinking block; a redacted block's
            // bytes already went out in its content_block_start.data.
            if (ev.signature && !reasoningRedacted) {
              yield frame("content_block_delta", { index: reasoningIndex, delta: { type: "signature_delta", signature: ev.signature } });
            }
            yield frame("content_block_stop", { index: reasoningIndex });
            reasoningOpen = false;
            reasoningRedacted = false;
          }
          break;
        case "tool_start": {
          // Close any open thinking/text block first; overlapping content blocks
          // make a strict Anthropic client drop the unclosed one (e.g. the
          // thinking block on a text-less, tool-only response).
          if (reasoningOpen) {
            yield frame("content_block_stop", { index: reasoningIndex });
            reasoningOpen = false;
          }
          if (textOpen) {
            yield frame("content_block_stop", { index: textIndex });
            textOpen = false;
          }
          const idx = nextIndex++;
          toolMap.set(ev.index, idx);
          yield frame("content_block_start", { index: idx, content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} } });
          break;
        }
        case "tool_args_delta": {
          const idx = toolMap.get(ev.index);
          if (idx != null) yield frame("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: ev.delta } });
          break;
        }
        case "tool_stop": {
          const idx = toolMap.get(ev.index);
          if (idx != null) {
            yield frame("content_block_stop", { index: idx });
            toolMap.delete(ev.index);
          }
          break;
        }
        case "finish":
          // A truncated upstream must not be dressed up as a finished answer:
          // no message_delta, no message_stop. relay() aborts the connection.
          if (ev.incomplete) return;
          if (reasoningOpen) {
            yield frame("content_block_stop", { index: reasoningIndex });
            reasoningOpen = false;
          }
          if (textOpen) {
            yield frame("content_block_stop", { index: textIndex });
            textOpen = false;
          }
          for (const idx of toolMap.values()) yield frame("content_block_stop", { index: idx });
          toolMap.clear();
          if (ev.usage) {
            inputTokens = ev.usage.promptTokens || inputTokens;
            outputTokens = ev.usage.completionTokens || outputTokens;
          }
          yield frame("message_delta", { delta: { stop_reason: stopToAnthropic(ev.stopReason), stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
          yield frame("message_stop", {});
          break;
      }
    }
  }
}

registerFormat("anthropic", { request: AnthropicRequest, response: AnthropicResponse });

export { stopReasonToStop, stopToAnthropic };
