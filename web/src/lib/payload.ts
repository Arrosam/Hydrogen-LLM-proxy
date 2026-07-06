/**
 * Best-effort extraction of a human-readable chat transcript from a logged
 * request/response payload (OpenAI or Anthropic shaped, or Hydrogen's
 * reconstructed streamed response). Falls back gracefully when the shape is
 * unrecognised.
 */

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
      const part = p as Record<string, unknown>;
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
        case "thinking":
        case "redacted_thinking":
          return ""; // shown as a separate "thinking" turn
        default:
          return typeof part.text === "string" ? part.text : "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

/** Thinking text of a content-block array (Anthropic "thinking" blocks). */
function thinkingOfParts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === "object" && (b as Record<string, unknown>).type === "thinking")
    .map((b) => String(b.thinking ?? ""))
    .filter(Boolean)
    .join("\n");
}

/** Reasoning attached to a message/response object, whatever the field style. */
function reasoningOf(obj: Record<string, unknown>): string {
  const direct = obj.reasoning ?? obj.reasoning_content;
  if (typeof direct === "string" && direct) return direct;
  return thinkingOfParts(obj.content);
}

function toolCallsText(calls: unknown): string {
  if (!Array.isArray(calls)) return "";
  return calls
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const call = c as Record<string, unknown>;
      const fn = (call.function ?? {}) as Record<string, unknown>;
      const name = String(fn.name ?? call.name ?? "");
      const args = String(fn.arguments ?? call.args ?? "");
      return name ? `[tool_call ${name}(${args})]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function parsePayload(json: string | null): PayloadMeta | null {
  if (!json) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const meta: { label: string; value: string }[] = [];
  for (const k of ["model", "max_tokens", "stream", "temperature", "top_p", "stop_reason", "finish_reason", "streamed"]) {
    if (obj[k] != null) meta.push({ label: k, value: String(obj[k]) });
  }
  if (obj.usage && typeof obj.usage === "object") {
    meta.push({ label: "usage", value: JSON.stringify(obj.usage) });
  }

  const tools: string[] = [];
  if (Array.isArray(obj.tools)) {
    for (const t of obj.tools) {
      if (!t || typeof t !== "object") continue;
      const tool = t as Record<string, unknown>;
      const fn = (tool.function ?? {}) as Record<string, unknown>;
      const name = fn.name ?? tool.name;
      if (name) tools.push(String(name));
    }
  }

  const turns: Turn[] = [];

  // System prompt (Anthropic-style top-level, or from message list below).
  if (obj.system != null) {
    const sys = partsToText(obj.system);
    if (sys) turns.push({ role: "system", text: sys });
  }

  // Request messages.
  if (Array.isArray(obj.messages)) {
    for (const raw of obj.messages) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const thinking = reasoningOf(m);
      if (thinking) turns.push({ role: "thinking", text: thinking });
      let text = partsToText(m.content);
      const tc = toolCallsText(m.tool_calls);
      if (tc) text = text ? `${text}\n${tc}` : tc;
      turns.push({ role: String(m.role ?? "user"), text });
    }
  }

  // OpenAI response choices.
  if (Array.isArray(obj.choices)) {
    for (const raw of obj.choices) {
      const c = (raw ?? {}) as Record<string, unknown>;
      const msg = (c.message ?? {}) as Record<string, unknown>;
      const thinking = reasoningOf(msg);
      if (thinking) turns.push({ role: "thinking", text: thinking });
      let text = partsToText(msg.content);
      const tc = toolCallsText(msg.tool_calls);
      if (tc) text = text ? `${text}\n${tc}` : tc;
      turns.push({ role: "assistant", text });
    }
  }

  // Anthropic response / Hydrogen streamed response: top-level content.
  if (obj.content != null && !Array.isArray(obj.messages) && !Array.isArray(obj.choices)) {
    const thinking = reasoningOf(obj);
    if (thinking) turns.push({ role: "thinking", text: thinking });
    let text = partsToText(obj.content);
    const tc = toolCallsText(obj.tool_calls);
    if (tc) text = text ? `${text}\n${tc}` : tc;
    turns.push({ role: String(obj.role ?? "assistant"), text });
  }

  if (turns.length === 0 && meta.length === 0 && tools.length === 0) return null;
  return { meta, tools, turns };
}
