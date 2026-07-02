/**
 * Canonical intermediate representation (IR) that both the OpenAI and Anthropic
 * wire formats convert to/from. Translation is always wire -> IR -> wire, so we
 * only implement each format once regardless of ingress/egress direction.
 */

export type Family = "openai" | "anthropic";

// --- content parts -------------------------------------------------------

export interface IRTextPart {
  type: "text";
  text: string;
}

export interface IRImagePart {
  type: "image";
  source:
    | { kind: "base64"; mediaType: string; data: string }
    | { kind: "url"; url: string };
}

export interface IRToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface IRToolResultPart {
  type: "tool_result";
  toolUseId: string;
  content: Array<IRTextPart | IRImagePart>;
  isError?: boolean;
}

export type IRContentPart = IRTextPart | IRImagePart | IRToolUsePart | IRToolResultPart;

// --- messages ------------------------------------------------------------

export interface IRMessage {
  role: "user" | "assistant";
  content: IRContentPart[];
}

export interface IRTool {
  name: string;
  description?: string;
  /** JSON Schema object for the tool's parameters. */
  parameters: Record<string, unknown>;
}

export type IRToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; name: string };

export interface IRRequest {
  /** The model field as sent by the client (a MUB name). Informational. */
  requestedModel: string;
  system?: string;
  messages: IRMessage[];
  tools?: IRTool[];
  toolChoice?: IRToolChoice;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  /** Extra provider-agnostic sampling params passed through verbatim. */
  extra?: Record<string, unknown>;
}

export interface IRUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type IRStopReason = "stop" | "length" | "tool_use" | "content_filter" | null;

export interface IRResponse {
  id: string;
  model: string;
  created: number; // epoch seconds
  content: IRContentPart[]; // assistant output: text + tool_use parts
  stopReason: IRStopReason;
  usage: IRUsage;
}

// --- helpers -------------------------------------------------------------

/** Concatenate the text parts of a content array. */
export function textOf(parts: IRContentPart[]): string {
  return parts
    .filter((p): p is IRTextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Merge consecutive same-role messages into one (Anthropic requires strictly
 * alternating user/assistant turns; OpenAI is lenient). Also drops empty messages.
 */
export function normalizeMessages(messages: IRMessage[]): IRMessage[] {
  const out: IRMessage[] = [];
  for (const m of messages) {
    if (m.content.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content.push(...m.content);
    } else {
      out.push({ role: m.role, content: [...m.content] });
    }
  }
  return out;
}
