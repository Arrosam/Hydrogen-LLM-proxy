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
  /** Anthropic prompt-caching breakpoint, preserved verbatim for same-family replay. */
  cacheControl?: unknown;
}

export interface ImagePart {
  type: "image";
  source: { kind: "base64"; mediaType: string; data: string } | { kind: "url"; url: string };
  cacheControl?: unknown;
}

/**
 * How a file's bytes are reached.
 *
 * `file_id` is a handle into ONE provider's own file storage, so it is scoped to
 * the family that issued it: replayed verbatim to that family, and never
 * translated into another's (the id means nothing there, and a family that
 * cannot express it must say so rather than drop the attachment silently).
 */
export type FileSource =
  | { kind: "base64"; mediaType: string; data: string }
  | { kind: "url"; url: string }
  | { kind: "file_id"; id: string; family: "openai_completion" | "anthropic" | "openai_responses" };

/** A document/file attachment (PDF etc.): Anthropic `document`, Responses
 * `input_file`, Chat Completions `file` content part. */
export interface FilePart {
  type: "file";
  source: FileSource;
  name?: string;
  cacheControl?: unknown;
}

/** A content part one wire family understands and the others cannot express
 * (e.g. Chat Completions `input_audio`). Replayed verbatim to the SAME family;
 * dropped when crossing families. */
export interface OpaquePart {
  type: "opaque";
  family: "openai_completion" | "anthropic" | "openai_responses";
  value: unknown;
}

export interface ToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cacheControl?: unknown;
  /**
   * Wire fields this call carries that the canonical shape has nowhere to keep:
   * `namespace` (Responses tool search), `caller` (programmatic tool calling),
   * and whatever a vendor adds next.
   *
   * Dropping them is not cosmetic. A namespaced call replayed without its
   * `namespace` is rejected with "Missing namespace for function_call", so a
   * conversation that used one broke on its second turn.
   *
   * Family-tagged, like {@link Tool.raw}: a field that means something on one
   * wire is never rendered onto another. Collected as "everything the canonical
   * part does not already model", so a field invented after this was written
   * survives a same-family round trip without a code change.
   */
  extra?: { family: "openai_completion" | "anthropic" | "openai_responses"; fields: Record<string, unknown> };
}

export interface ToolResultPart {
  type: "tool_result";
  toolUseId: string;
  content: Array<TextPart | ImagePart>;
  isError?: boolean;
  cacheControl?: unknown;
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
  /** Anthropic redacted_thinking: the opaque bytes live in `signature`, `text`
   * is empty, and only a same-family replay can restore the block. */
  redacted?: boolean;
}

export type ContentPart = TextPart | ImagePart | FilePart | OpaquePart | ToolUsePart | ToolResultPart | ReasoningPart;

export interface Message {
  role: "user" | "assistant";
  content: ContentPart[];
  /** OpenAI Chat Completions participant name, kept for same-family replay. */
  name?: string;
}

export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema object for the tool's parameters. */
  parameters: Record<string, unknown>;
  /** OpenAI structured-outputs strict flag. */
  strict?: boolean;
  cacheControl?: unknown;
  /**
   * The Responses `namespace` this tool was declared inside.
   *
   * Only the Responses wire has namespaces. Everywhere else the member is
   * declared as an ordinary function under {@link flatToolName}, because the
   * alternative — dropping the whole namespace, as this proxy used to — costs a
   * Codex client ten of its fourteen tools the moment a step resolves to a
   * non-Responses provider.
   *
   * A member tool is stored ALONGSIDE the namespace's own `raw` entry: the raw
   * one replays the namespace verbatim to a Responses upstream, and the members
   * are what every other family renders.
   */
  namespace?: string;
  /** A provider-executed (server-side) or otherwise family-specific tool
   * declaration, kept verbatim: replayed untouched to the SAME family, dropped
   * when crossing families (never mangled into an empty client tool). */
  raw?: { family: "openai_completion" | "anthropic" | "openai_responses"; value: unknown };
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
      if (!last.name && m.name) last.name = m.name;
    } else {
      out.push({ role: m.role, content: [...m.content], ...(m.name ? { name: m.name } : {}) });
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

// --- namespaced tools ----------------------------------------------------

/**
 * The separator between a namespace and its member on a wire that has no
 * namespaces. `__` is not arbitrary: it is the convention the Responses API
 * itself uses for flat MCP tools (`mcp__server__tool`), so a model that has seen
 * one reads the other the same way.
 */
export const NAMESPACE_SEP = "__";

/** The name a namespaced tool takes where namespaces do not exist. */
export function flatToolName(name: string, namespace?: string): string {
  return namespace ? `${namespace}${NAMESPACE_SEP}${name}` : name;
}

/** The namespace a tool call carries, if it carries one. */
export function toolNamespaceOf(part: ToolUsePart): string | undefined {
  if (part.extra?.family !== "openai_responses") return undefined;
  const ns = part.extra.fields.namespace;
  return typeof ns === "string" && ns ? ns : undefined;
}

/**
 * Split a flattened name back into its namespace and member, given the
 * namespaces that were actually declared for this request.
 *
 * Matched against the declared list rather than by splitting on the last `__`,
 * because a client is free to declare a plain function tool whose own name
 * contains the separator, and guessing would rename it. The longest match wins,
 * so nested-looking namespaces resolve to the most specific one.
 */
export function splitToolName(flat: string, namespaces: readonly string[]): { name: string; namespace?: string } {
  let best: string | undefined;
  for (const ns of namespaces) {
    const prefix = ns + NAMESPACE_SEP;
    if (flat.startsWith(prefix) && flat.length > prefix.length && (!best || ns.length > best.length)) best = ns;
  }
  return best ? { name: flat.slice(best.length + NAMESPACE_SEP.length), namespace: best } : { name: flat };
}

/** Attach a namespace to a tool call, in the shape ToolUsePart.extra expects. */
export function withToolNamespace(part: ToolUsePart, namespace: string): ToolUsePart {
  const fields = { ...(part.extra?.family === "openai_responses" ? part.extra.fields : {}), namespace };
  return { ...part, extra: { family: "openai_responses", fields } };
}
