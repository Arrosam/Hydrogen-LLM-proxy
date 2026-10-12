/**
 * Best-effort extraction of a human-readable chat transcript from a logged
 * request/response payload (OpenAI or Anthropic shaped, or Hydrogen's
 * reconstructed streamed response). Falls back gracefully when the shape is
 * unrecognised.
 */

/**
 * The spellings a server may put its trace under, in the same order the
 * server-side parser reads them (see core/format/completion.ts). First
 * NON-EMPTY wins, so an empty `reasoning: ""` cannot mask a populated
 * `reasoning_content` -- reading only the first present field, or only two
 * of the four, is why a log row could show no thinking at all for a response
 * whose trace arrived under `thinking` or `reasoning_text`.
 */
const REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text", "thinking"] as const;

/** Content-part types that are the model's trace rather than its answer. */
const THINKING_PART_TYPES: readonly unknown[] = ["thinking", "redacted_thinking", "reasoning", "reasoning_text"];

/** Whether a content part is the model's trace rather than its answer. */
function isThinkingPart(type: unknown): boolean {
  return THINKING_PART_TYPES.includes(type);
}

/** Top-level scalar fields worth showing as a badge, in display order. */
const META_FIELDS = ["model", "max_tokens", "max_output_tokens", "stream", "temperature", "top_p", "stop_reason", "finish_reason", "streamed"] as const;

/** Role names the transcript assigns itself. */
const ROLE = { system: "system", user: "user", assistant: "assistant", thinking: "thinking" } as const;

type Json = Record<string, unknown>;

/** `value` as an object to read fields off; anything else reads as empty. */
const asObject = (value: unknown): Json => (value ?? {}) as Json;

/** The name of a tool or tool call, wherever its wire puts it: under `function`, or on the entry itself. */
function functionOf(entry: Json): { fn: Json; name: unknown } {
  const fn = asObject(entry.function);
  return { fn, name: fn.name ?? entry.name };
}

export interface Turn {
  role: string;
  text: string;
}

export interface PayloadMeta {
  meta: { label: string; value: string }[];
  tools: string[];
  turns: Turn[];
}

function partsToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (!p || typeof p !== "object") return "";
      const part = p as Json;
      if (isThinkingPart(part.type)) return ""; // shown as a separate "thinking" turn
      switch (part.type) {
        case "text":
        case "input_text":
        case "output_text":
          return String(part.text ?? "");
        case "image":
        case "image_url":
          return "[image]";
        case "tool_use":
          return `[tool_use ${String(part.name ?? "")}(${JSON.stringify(part.input ?? {})})]`;
        case "tool_result":
          return `[tool_result${part.is_error ? " error" : ""}] ${partsToText(part.content)}`;
        default:
          return typeof part.text === "string" ? part.text : "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

/** Thinking text of a content-block array: An Anthropic thinking block, or a
 * reasoning part from a server that sends its trace as content parts. */
function thinkingOfParts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Json => Boolean(b) && typeof b === "object" && isThinkingPart((b as Json).type))
    .map((b) => String(b.thinking ?? b.text ?? b.summary ?? ""))
    .filter(Boolean)
    .join("\n");
}

/** Reasoning attached to a message/response object, whatever the field style. */
function reasoningOf(obj: Json): string {
  for (const field of REASONING_FIELDS) {
    const value = obj[field];
    if (typeof value === "string" && value) return value;
  }
  return thinkingOfParts(obj.content);
}

function toolCallsText(calls: unknown): string {
  if (!Array.isArray(calls)) return "";
  return calls
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const call = c as Json;
      const { fn, name: rawName } = functionOf(call);
      const name = String(rawName ?? "");
      const args = String(fn.arguments ?? call.args ?? "");
      return name ? `[tool_call ${name}(${args})]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * One message as transcript turns: its trace first (when it has one), then its
 * text with any tool calls appended.
 */
function pushMessage(turns: Turn[], message: Json, role: string): void {
  const thinking = reasoningOf(message);
  if (thinking) turns.push({ role: ROLE.thinking, text: thinking });
  const text = partsToText(message.content);
  const calls = toolCallsText(message.tool_calls);
  turns.push({ role, text: calls ? (text ? `${text}\n${calls}` : calls) : text });
}

export function parsePayload(json: string | null): PayloadMeta | null {
  if (!json) return null;
  let obj: Json;
  try {
    obj = JSON.parse(json) as Json;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const meta: { label: string; value: string }[] = [];
  for (const k of META_FIELDS) {
    if (obj[k] != null) meta.push({ label: k, value: String(obj[k]) });
  }
  if (obj.thinking != null) meta.push({ label: "thinking", value: JSON.stringify(obj.thinking) });
  if (obj.reasoning_effort != null) meta.push({ label: "reasoning_effort", value: String(obj.reasoning_effort) });
  if (obj.reasoning != null && typeof obj.reasoning === "object") {
    meta.push({ label: "reasoning", value: JSON.stringify(obj.reasoning) });
  }
  if (obj.usage && typeof obj.usage === "object") {
    meta.push({ label: "usage", value: JSON.stringify(obj.usage) });
  }
  if (obj.incomplete === true) meta.push({ label: "incomplete", value: "stream truncated upstream" });

  const tools: string[] = [];
  if (Array.isArray(obj.tools)) {
    for (const t of obj.tools) {
      if (!t || typeof t !== "object") continue;
      const { name } = functionOf(t as Json);
      if (name) tools.push(String(name));
    }
  }

  const turns: Turn[] = [];

  // System prompt (Anthropic-style top-level, or from message list below).
  if (obj.system != null) {
    const sys = partsToText(obj.system);
    if (sys) turns.push({ role: ROLE.system, text: sys });
  }

  // Request messages.
  if (Array.isArray(obj.messages)) {
    for (const raw of obj.messages) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Json;
      pushMessage(turns, m, String(m.role ?? ROLE.user));
    }
  }

  // OpenAI response choices.
  if (Array.isArray(obj.choices)) {
    for (const raw of obj.choices) {
      pushMessage(turns, asObject(asObject(raw).message), ROLE.assistant);
    }
  }

  // Anthropic response / Hydrogen streamed response: top-level content.
  if (obj.content != null && !Array.isArray(obj.messages) && !Array.isArray(obj.choices)) {
    pushMessage(turns, obj, String(obj.role ?? ROLE.assistant));
  }

  if (turns.length === 0 && meta.length === 0 && tools.length === 0) return null;
  return { meta, tools, turns };
}
