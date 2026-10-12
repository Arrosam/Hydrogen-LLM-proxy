import type { Family } from "./params";
import { reasoningOf, textOf, toolCallsOf, type ContentPart } from "./content";
import type { Usage } from "./usage";
import type { ResponseData } from "./stream";
import { applyThinkingFormat, type ThinkingDelimiters, type ThinkingFormat } from "./thinkingFormat";
import { buildResponse } from "../format/registry";

export type { ResponseData };

/** Per-render choices a service makes about the client's copy of the answer. */
export interface RenderOptions {
  /** Which wire spelling reasoning goes out under. Meaningful on the Chat
   * Completions wire only; the other two have one native shape each. */
  thinkingFormat?: ThinkingFormat;
}

/**
 * Base class for a model response in canonical form -- a complete, multi-purpose
 * data object. It can render itself into ANY client wire family (a response
 * parsed from an Anthropic upstream can be delivered to an OpenAI client), tap
 * off its text/reasoning/tool-calls for logging, strip reasoning to honor a
 * "disabled" thinking level, and hand its data to `fabricateStream` when a
 * buffered result must be delivered to a streaming client. The three format
 * subclasses add `static parse` (wire -> canonical), `renderSelf` (canonical ->
 * their wire), the streaming parse/serialize for their family, and the check
 * that a buffered body is their envelope.
 */
export abstract class Response implements ResponseData {
  id: string;
  model: string;
  created: number;
  content: ContentPart[];
  stopReason: ResponseData["stopReason"];
  usage: Usage;

  constructor(data: ResponseData) {
    this.id = data.id;
    this.model = data.model;
    this.created = data.created;
    this.content = data.content;
    this.stopReason = data.stopReason;
    this.usage = data.usage;
  }

  /**
   * Whether a buffered 2xx body reports a generation that did not finish, in a
   * way particular to the family (a top-level `error` is checked for all of
   * them by the caller). None does by default; a family with a status field
   * overrides this.
   */
  static isUnfinished(_body: Record<string, unknown>): boolean {
    return false;
  }

  /** The wire family this subclass's `renderSelf` produces. */
  abstract readonly family: Family;

  /** Render this response into its own wire family. `model` is echoed to the client. */
  abstract renderSelf(model: string, opts?: RenderOptions): Record<string, unknown>;

  /** A shallow structural copy of the canonical fields. */
  data(): ResponseData {
    return {
      id: this.id,
      model: this.model,
      created: this.created,
      content: this.content,
      stopReason: this.stopReason,
      usage: this.usage,
    };
  }

  /** Concatenated assistant text. */
  text(): string {
    return textOf(this.content);
  }

  /** Concatenated reasoning/thinking text. */
  reasoning(): string {
    return reasoningOf(this.content);
  }

  /** Tool calls as name + JSON-stringified arguments. */
  toolCalls(): Array<{ id: string; name: string; args: string }> {
    return toolCallsOf(this.content);
  }

  /** A copy with reasoning parts removed (honors a "disabled" thinking level even
   * when the upstream ignored the request and returned thinking anyway). */
  withoutReasoning(): this {
    const content = this.content.filter((p) => p.type !== "reasoning");
    if (content.length === this.content.length) return this;
    return this.withContent(content);
  }

  /**
   * A copy whose thinking is shaped the way this service presents it: lifted
   * out of `<think>` tags, inlined into the answer, or dropped. `original`
   * (and absence) returns `this` untouched -- see ir/thinkingFormat.ts.
   */
  withThinkingFormat(format: ThinkingFormat | undefined, delimiters?: ThinkingDelimiters): this {
    const content = applyThinkingFormat(this.content, format, delimiters);
    if (content === this.content) return this;
    return this.withContent(content);
  }

  /** A NEW response of the same family (the same subclass) carrying `content` instead. */
  private withContent(content: ContentPart[]): this {
    return new (this.constructor as new (d: ResponseData) => this)({ ...this.data(), content });
  }

  /** Render into any client wire family (dispatched to that family's subclass). */
  render(family: Family, model: string, opts?: RenderOptions): Record<string, unknown> {
    return buildResponse(family, this.data()).renderSelf(model, opts);
  }

  /** A compact structured view for the request log (text + reasoning + tool calls). */
  toLogPayload(extra?: Record<string, unknown>): Record<string, unknown> {
    const reasoning = this.reasoning();
    const toolCalls = this.toolCalls().map((t) => ({ name: t.name, args: t.args }));
    return {
      role: "assistant",
      content: this.text(),
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      stop_reason: this.stopReason,
      usage: this.usage,
      ...extra,
    };
  }
}
