import type { Family } from "./params";
import { reasoningOf, textOf, toolCallsOf, type ContentPart } from "./content";
import type { Usage } from "./usage";
import { fabricateStream, type ResponseData, type StreamContext } from "./stream";
import { buildResponse, serializeStream } from "../format/registry";

export type { ResponseData };

/**
 * Base class for a model response in canonical form -- a complete, multi-purpose
 * data object. It can render itself into ANY client wire family (a response
 * parsed from an Anthropic upstream can be delivered to an OpenAI client), tap
 * off its text/reasoning/tool-calls for logging, strip reasoning to honor a
 * "disabled" thinking level, and fabricate a paced client stream when a buffered
 * result must be delivered to a streaming client. The three format subclasses add
 * `static parse` (wire -> canonical), `renderSelf` (canonical -> their wire), and
 * the streaming parse/serialize for their family.
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

  /** The wire family this subclass's `renderSelf` produces. */
  abstract readonly family: Family;

  /** Render this response into its own wire family. `model` is echoed to the client. */
  abstract renderSelf(model: string): Record<string, unknown>;

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
    return new (this.constructor as new (d: ResponseData) => this)({ ...this.data(), content });
  }

  /** Render into any client wire family (dispatched to that family's subclass). */
  render(family: Family, model: string): Record<string, unknown> {
    return buildResponse(family, this.data()).renderSelf(model);
  }

  /** A paced client SSE stream (in `family`) fabricated from this complete response. */
  fabricate(family: Family, ctx: StreamContext): AsyncGenerator<string> {
    return serializeStream(family, fabricateStream(this.data()), ctx);
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
