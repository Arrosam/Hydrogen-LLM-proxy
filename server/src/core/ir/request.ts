import type { Family, GenerationParams, RequestOverrides } from "./params";
import { mergeParams } from "./params";
import {
  normalizeMessages,
  stripStaleReasoning,
  type Message,
  type Tool,
  type ToolChoice,
} from "./content";
import type { SendTarget, Transport } from "../upstream/transport";
import type { RelayResult, SendResult } from "../upstream/outcome";

/** The canonical, format-independent request the proxy carries internally. */
export interface RequestData {
  /** The model field as sent by the client (a Model Service / Micro Agent name). */
  requestedService: string;
  system?: string;
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  /** All sampling/generation knobs (temperature, thinking, response_format, ...). */
  params: GenerationParams;
  stream: boolean;
}

/** What a render needs beyond the canonical data: the concrete upstream target. */
export interface RenderTarget {
  upstreamModel: string;
  /** The provider's hard output-token cap; thinking budgets fit under it. */
  providerMaxOutputTokens?: number;
}

/**
 * Base class for a request in canonical form. The whole proxy pipeline operates
 * on this shape; the three format subclasses ({@link OpenAIRequest},
 * {@link AnthropicRequest}, {@link ResponsesRequest}) add `static parse` (wire ->
 * canonical) and `render` (canonical -> their wire). A ModelService/MicroAgent
 * chooses the egress subclass at send time from the resolved provider.
 */
export abstract class Request implements RequestData {
  requestedService: string;
  system?: string;
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  params: GenerationParams;
  stream: boolean;

  constructor(data: RequestData) {
    this.requestedService = data.requestedService;
    this.system = data.system;
    this.messages = data.messages;
    this.tools = data.tools;
    this.toolChoice = data.toolChoice;
    this.params = data.params;
    this.stream = data.stream;
  }

  /** The wire family this subclass renders to. */
  abstract readonly family: Family;

  /** Render this canonical request into its wire body for the given upstream. */
  abstract render(target: RenderTarget): Record<string, unknown>;

  /**
   * Emit this request and buffer the reply into one complete Response. Abstract
   * here because a canonical Request must first be `construct`ed into a concrete
   * format subclass (which knows how to render and how to parse its own reply);
   * the subclasses implement it as a thin call to the shared round-trip.
   */
  abstract send(transport: Transport, target: SendTarget): Promise<SendResult>;

  /** Emit this request and return the committed live event stream (client relay). */
  abstract relay(transport: Transport, target: SendTarget): Promise<RelayResult>;

  /** A shallow structural copy of the canonical fields. */
  data(): RequestData {
    return {
      requestedService: this.requestedService,
      system: this.system,
      messages: this.messages,
      tools: this.tools,
      toolChoice: this.toolChoice,
      params: this.params,
      stream: this.stream,
    };
  }

  /**
   * Apply an override patch, returning a NEW request of the SAME family. Override
   * params win over the current request's; `system`/`stream` may be replaced.
   * Full precedence (override > service config > client) is realized by layering
   * patches, each call winning over the last:
   *   client.withOverrides(stepConfig).withOverrides(callerOverride)
   */
  withOverrides(o?: RequestOverrides): this {
    if (!o) return this;
    const { stream, system, ...paramPatch } = o;
    const next: RequestData = {
      ...this.data(),
      params: mergeParams(this.params, paramPatch),
    };
    if (system !== undefined) next.system = system;
    if (stream !== undefined) next.stream = stream;
    return new (this.constructor as new (d: RequestData) => this)(next);
  }

  /** Force the transport mode (a Micro Agent sets stream:false for internal calls). */
  withStream(stream: boolean): this {
    if (stream === this.stream) return this;
    return new (this.constructor as new (d: RequestData) => this)({ ...this.data(), stream });
  }

  /** Merge same-role messages and drop stale prior-turn reasoning. */
  normalized(): this {
    const messages = stripStaleReasoning(normalizeMessages(this.messages));
    return new (this.constructor as new (d: RequestData) => this)({ ...this.data(), messages });
  }
}
