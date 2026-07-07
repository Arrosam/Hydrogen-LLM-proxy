/**
 * Canonical message content — the normalized shape every wire format parses into
 * and renders from. A request carries a list of {@link Message}s; a response
 * carries a list of {@link ContentPart}s. Translation is always
 * wire -> canonical -> wire, so each format is implemented once regardless of
 * whether it is the client's (ingress) or the upstream's (egress) side.
 */

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  source: { kind: "base64"; mediaType: string; data: string } | { kind: "url"; url: string };
}

export interface ToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: "tool_result";
  toolUseId: string;
  content: Array<TextPart | ImagePart>;
  isError?: boolean;
}

/** A reasoning/thinking block produced by the model (extended thinking). */
export interface ReasoningPart {
  type: "reasoning";
  text: string;
  /** Provider signature for the block (Anthropic thinking/redacted_thinking). */
  signature?: string;
}

export type ContentPart = TextPart | ImagePart | ToolUsePart | ToolResultPart | ReasoningPart;

export interface Message {
  role: "user" | "assistant";
  content: ContentPart[];
}

export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema object for the tool's parameters. */
  parameters: Record<string, unknown>;
}

export type ToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; name: string };

export type StopReason = "stop" | "length" | "tool_use" | "content_filter" | null;

// --- content helpers -------------------------------------------------------

/** Concatenate the text parts of a content array. */
export function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Concatenate the reasoning/thinking text of a content array. */
export function reasoningOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is ReasoningPart => p.type === "reasoning")
    .map((p) => p.text)
    .join("");
}

/** The tool calls in a content array, name + JSON-stringified arguments. */
export function toolCallsOf(parts: ContentPart[]): Array<{ id: string; name: string; args: string }> {
  return parts
    .filter((p): p is ToolUsePart => p.type === "tool_use")
    .map((p) => ({ id: p.id, name: p.name, args: JSON.stringify(p.input ?? {}) }));
}

/**
 * Merge consecutive same-role messages into one (Anthropic requires strictly
 * alternating user/assistant turns; OpenAI is lenient). Also drops empty messages.
 */
export function normalizeMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
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

/**
 * Drop reasoning/thinking blocks carried in from earlier turns of the request
 * history. Resending them is what makes a continued conversation lose its
 * thinking while a fresh one keeps it: an Anthropic upstream needs a valid
 * signature on a resent thinking block (relayed/cross-provider ones don't have
 * one), DeepSeek rejects reasoning_content sent back to it, and other providers
 * just don't re-engage thinking when the history already "thought".
 *
 * Reasoning is kept only inside the CURRENT turn's tool-use loop -- the messages
 * after the last user message that carries real input (text/image); a pure
 * tool_result is a continuation, not a new turn -- because Anthropic *requires*
 * the thinking block there when a tool_result is sent back. Everything before
 * that is a completed turn whose reasoning is stale and dropped.
 */
export function stripStaleReasoning(messages: Message[]): Message[] {
  let turnStart = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.content.some((p) => p.type === "text" || p.type === "image")) {
      turnStart = i;
      break;
    }
  }
  if (turnStart <= 0) return messages; // no prior turn to strip
  return messages.map((m, i) => {
    if (i >= turnStart || m.role !== "assistant" || !m.content.some((p) => p.type === "reasoning")) return m;
    return { ...m, content: m.content.filter((p) => p.type !== "reasoning") };
  });
}
