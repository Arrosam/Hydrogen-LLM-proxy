/**
 * Tool list and tool choice translation shared by the format subclasses.
 *
 * All three wires carry the same two things -- function tools the model may
 * call, and built-in tools only their own provider understands -- and differ in
 * where the fields sit. One walk does the parsing and one the rendering; each
 * wire supplies a {@link ToolWire} naming exactly what is its own.
 */

import type { Tool, ToolChoice } from "../ir/content";
import type { Family } from "../ir/params";
import { objectsIn } from "./wire";

/** The schema a function tool is given when it declared none. A factory: the object is handed to callers that may mutate it. */
export function emptyObjectSchema(): Record<string, unknown> {
  return { type: "object", properties: {} };
}

/** What one wire family contributes to the shared tool list walk. */
export interface ToolWire {
  family: Family;
  /**
   * The object holding a function tool's name / description / schema, or
   * undefined when the entry is not a function tool this wire models.
   */
  functionFields(entry: Record<string, unknown>): Record<string, unknown> | undefined;
  /** Key of the JSON Schema inside those fields. */
  schemaKey: string;
  /** Canonical fields beyond name / description / parameters (`strict`, `cacheControl`). */
  extras(fields: Record<string, unknown>): Partial<Tool>;
  /**
   * The name under which a tool this wire cannot model (a built-in or
   * server-side tool) is kept verbatim for same-family replay; undefined drops
   * the entry.
   */
  nativeName(entry: Record<string, unknown>): string | undefined;
  /** A canonical function tool in this wire's shape. */
  render(tool: Tool): Record<string, unknown>;
}

export function parseToolList(raw: unknown, wire: ToolWire): Tool[] | undefined {
  const tools: Tool[] = [];
  for (const entry of objectsIn(raw)) {
    const fields = wire.functionFields(entry);
    if (!fields) {
      const name = wire.nativeName(entry);
      if (name !== undefined) tools.push({ name, parameters: {}, raw: { family: wire.family, value: entry } });
      continue;
    }
    tools.push({
      name: String(fields.name),
      description: fields.description ? String(fields.description) : undefined,
      parameters: (fields[wire.schemaKey] as Record<string, unknown>) ?? emptyObjectSchema(),
      ...wire.extras(fields),
    });
  }
  return tools.length ? tools : undefined;
}

/**
 * The outgoing `tools` array, or undefined when nothing is left to send. A
 * same-family built-in replays verbatim; another family's is dropped (it cannot
 * be expressed here) rather than sent as an empty client tool.
 */
export function renderToolList(tools: Tool[] | undefined, wire: ToolWire): unknown[] | undefined {
  if (!tools) return undefined;
  const rendered = tools
    .filter((t) => !t.raw || t.raw.family === wire.family)
    .map((t) => (t.raw ? t.raw.value : wire.render(t)));
  return rendered.length ? rendered : undefined;
}

// --- tool choice (the two OpenAI wires) -------------------------------------

/** The string forms of an OpenAI `tool_choice`. */
export const OPENAI_TOOL_CHOICE = {
  AUTO: "auto",
  NONE: "none",
  REQUIRED: "required",
} as const;

/** `type` of an OpenAI function tool, tool call and named tool choice. */
export const OPENAI_TOOL_TYPE_FUNCTION = "function";

/**
 * Parse an OpenAI `tool_choice`. The string forms are shared; `namedTool` reads
 * the name out of the object form, which each wire shapes (and validates) its
 * own way, returning a falsy value when the object does not name a tool.
 */
export function parseOpenAiToolChoice(raw: unknown, namedTool: (choice: Record<string, unknown>) => unknown): ToolChoice | undefined {
  if (raw == null) return undefined;
  if (raw === OPENAI_TOOL_CHOICE.AUTO) return { type: "auto" };
  if (raw === OPENAI_TOOL_CHOICE.NONE) return { type: "none" };
  if (raw === OPENAI_TOOL_CHOICE.REQUIRED) return { type: "required" };
  if (typeof raw === "object") {
    const name = namedTool(raw as Record<string, unknown>);
    if (name) return { type: "tool", name: String(name) };
  }
  return undefined;
}

/** Render a canonical tool choice for an OpenAI wire; `named` builds the object form. */
export function renderOpenAiToolChoice(choice: ToolChoice, named: (name: string) => unknown): unknown {
  switch (choice.type) {
    case "auto":
      return OPENAI_TOOL_CHOICE.AUTO;
    case "none":
      return OPENAI_TOOL_CHOICE.NONE;
    case "required":
      return OPENAI_TOOL_CHOICE.REQUIRED;
    case "tool":
      return named(choice.name);
  }
}
