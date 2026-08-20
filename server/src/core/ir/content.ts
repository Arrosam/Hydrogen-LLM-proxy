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
  /** Provider signature for the block (Anthropic thinking/redacted_thinking),
   * or the OpenAI Responses reasoning item's encrypted_content. */
  signature?: string;
  /** OpenAI Responses reasoning item id (rs_...), kept so a same-family replay
   * restores the item verbatim (encrypted_content is tied to its item id). */
  itemId?: string;
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
 * history when resending them can only hurt. Reasoning is always kept inside
 * the CURRENT turn's tool-use loop -- the messages after the last user message
 * that carries real input (text/image); a pure tool_result is a continuation,
 * not a new turn -- because both Anthropic and DeepSeek *require* it there when
 * a tool_result is sent back.
 *
 * APPLIED PER EGRESS FAMILY, AT RENDER TIME -- not when a request is parsed.
 * The families disagree about resent thinking, and stripping at parse time
 * decided for every provider before the egress was even known. The canonical
 * Request carries all the reasoning; each renderer applies its own rule:
 *  - Anthropic egress keeps everything (never calls this): the Anthropic wire
 *    format *requires* thinking back -- DeepSeek's Anthropic-compatible
 *    endpoint rejects a thinking-mode request whose history has none.
 *  - OpenAI-family egress calls this with the default `keepToolTurns` true: an
 *    assistant turn that called tools keeps its reasoning, because DeepSeek's
 *    thinking mode (on by default since v4) returns 400 ("reasoning_content
 *    ... must be passed back to the API") when a tool-calling assistant
 *    message anywhere in the history arrives without it. Reasoning on
 *    tool-less prior turns is still dropped -- no provider needs it, and a
 *    history that already "thought" stops some providers re-engaging thinking.
 *  - `keepToolTurns` false drops every prior-turn block, for egress targets
 *    that validate signatures on resent thinking.
 */
export function stripStaleReasoning(messages: Message[], opts: { keepToolTurns?: boolean } = {}): Message[] {
  const keepToolTurns = opts.keepToolTurns ?? true;
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
    if (keepToolTurns && m.content.some((p) => p.type === "tool_use")) return m;
    return { ...m, content: m.content.filter((p) => p.type !== "reasoning") };
  });
}

/**
 * Move an assistant message's reasoning to the front of its content.
 *
 * Anthropic puts thinking FIRST in an assistant turn, but the OpenAI wire shape
 * carries reasoning as a sibling field of the content (`reasoning_content`), so
 * parsing one yields `[text, reasoning]` — rendered verbatim that is an invalid
 * Anthropic message. A stable partition, so content that is already in the right
 * order (anything parsed from Anthropic itself) comes back untouched.
 */
export function orderReasoningFirst(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.content.some((p) => p.type === "reasoning")) return m;
    return {
      ...m,
      content: [
        ...m.content.filter((p) => p.type === "reasoning"),
        ...m.content.filter((p) => p.type !== "reasoning"),
      ],
    };
  });
}
