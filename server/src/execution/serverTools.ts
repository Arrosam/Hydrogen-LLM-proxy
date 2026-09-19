import { genId } from "../util/ids";
import type { ContentPart, Message, ServerToolResultPart, Tool } from "../core/ir/content";
import type { HttpTool } from "./toolHttp";
import { serverToolOutcome } from "./toolHttp";

/**
 * Provider-executed ("server-side") tool round trips, in a protocol-agnostic
 * form.
 *
 * This module owns exactly one decision: WHICH incoming declarations the proxy
 * answers with a full round trip. It never knows what a tool does, what an
 * adapter returns, or which block type carries the answer — that is the tool's
 * own `serverTool` configuration (toolHttp.ts) and the renderer's job.
 */

/** A client tool declaration the client marked as provider-executed. */
export interface ServerToolDeclaration {
  /** Name the client declared; a tool's `serverTool.name` matches against this. */
  name: string;
  /** The declaration's raw type, echoed back in its own vocabulary. */
  type: string;
}

/**
 * The server-tool declaration behind a parsed tool, if it is one.
 *
 * Both wires spell provider-executed tools as a `type` with no schema, and the
 * request parsers keep the raw declaration because a client tool with the same
 * name must NOT be treated as one:
 *
 *   Anthropic  `{ type: "web_search_20250305", name: "web_search" }` — the name
 *              is explicit and may be any provider tool spelling.
 *   Responses  `{ type: "web_search" }` (or `web_search_2025_08_26`) — the type
 *              IS the name; there is no separate field.
 */
export function serverToolDeclaration(tool: Tool): ServerToolDeclaration | undefined {
  if (!tool.raw || (tool.raw.family !== "anthropic" && tool.raw.family !== "openai_responses")) return undefined;
  const value = tool.raw.value as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return undefined;
  const type = typeof value.type === "string" ? value.type : "";
  if (!type) return undefined;
  return { name: String(value.name ?? type), type };
}

/**
 * Declarations in the request that are answered by a bound tool's serverTool
 * contract, keyed by the BOUND tool's name.
 *
 * One key serves both lookups. The history collector finds the call the model
 * made, which is always the bound name; the rewriter finds the client's
 * declaration, whose name may differ (a client declares `web_search` while the
 * operator bound `search`).
 */
export function hostedServerTools(tools: Tool[] | undefined, bound: HttpTool[]): Map<string, { tool: HttpTool; declaration: ServerToolDeclaration }> {
  const byDeclared = new Map<string, HttpTool>();
  for (const tool of bound) if (tool.serverTool) byDeclared.set(tool.serverTool.name, tool);
  const matched = new Map<string, { tool: HttpTool; declaration: ServerToolDeclaration }>();
  for (const tool of tools ?? []) {
    const declaration = serverToolDeclaration(tool);
    if (!declaration) continue;
    const boundTool = byDeclared.get(declaration.name);
    if (boundTool) matched.set(boundTool.name, { tool: boundTool, declaration });
  }
  return matched;
}

/** The same matches, indexed by the name the client declared. */
export function declaredServerTools(matched: Map<string, { tool: HttpTool; declaration: ServerToolDeclaration }>): Map<string, { tool: HttpTool; declaration: ServerToolDeclaration }> {
  return new Map([...matched.values()].map(entry => [entry.declaration.name, entry]));
}

/**
 * Rewrite a declared server tool into the real bound tool so the model sees the
 * adapter's own schema — the client's declaration carries no parameters, and
 * without this the model would be handed a tool it cannot call.
 */
export function rewriteServerTools(tools: Tool[] | undefined, matched: Map<string, { tool: HttpTool; declaration: ServerToolDeclaration }>): Tool[] | undefined {
  if (!tools?.length) return tools;
  const byDeclared = declaredServerTools(matched);
  return tools.map(tool => {
    const declaration = serverToolDeclaration(tool);
    const entry = declaration ? byDeclared.get(declaration.name) : undefined;
    if (!entry) return tool;
    return { name: entry.tool.name, description: entry.tool.description, parameters: entry.tool.parameters, hosted: true };
  });
}

/** One executed provider-side call, paired with the adapter's raw output. */
export interface ServerToolCall {
  /** Declared name, as the server tool use block must report it. */
  name: string;
  id: string;
  input: unknown;
  tool: HttpTool;
  /** Selected adapter output, parsed. */
  payload: unknown;
  /** True when the adapter, the schema, or the call budget failed. */
  isError: boolean;
}

/** The tool_use a hosted round produced, and the adapter output it returned. */
function toolResultText(message: Message, toolUseId: string): string | undefined {
  for (const part of message.content) {
    if (part.type !== "tool_result" || part.toolUseId !== toolUseId) continue;
    return part.content.filter(p => p.type === "text").map(p => p.text).join("");
  }
  return undefined;
}

function resultIsError(message: Message, toolUseId: string): boolean {
  for (const part of message.content) if (part.type === "tool_result" && part.toolUseId === toolUseId) return part.isError === true;
  return false;
}

/**
 * Pair every provider-executed call in the run's history with its result, in
 * round order. `history` carries the UNTRUNCATED adapter output for the whole
 * run — unlike the request trace, which is clipped for the log — so this is the
 * one place the client-facing result can be built from real data.
 */
/**
 * Rebuild the whole client-facing content sequence from the run's history.
 *
 * Prepending the round trip to the final response loses the turns in between: a
 * first round that said "let me search" and then called a tool would reach the
 * client as the call, the result, and only the LAST round's answer. This wire
 * shape puts text, then the call, then its result, then the answer — in order,
 * all inside one assistant turn — so the sequence has to come from the history
 * that recorded every round, not from the final response.
 *
 * Each assistant turn is reduced the way the loop reduces the final one: drop
 * the internal `tool_use` for a bound tool (the round trip replaces it) and drop
 * redacted reasoning, which only a same-family Anthropic replay could restore.
 * Every remaining part keeps its position.
 */
export function serverToolResponseContent(
  history: Message[],
  parts: ServerToolResultPart[],
  prefix: number,
): ContentPart[] {
  const byId = new Map(parts.map(part => [part.id, part]));
  const content: ContentPart[] = [];
  for (const message of history.slice(prefix)) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "reasoning" && part.redacted) continue;
      if (part.type === "tool_use") {
        // A client tool call stays a client tool call; only the calls this run
        // executed on the model's behalf become the round trip.
        const call = byId.get(part.id);
        if (!call) content.push(part);
        else if (!content.includes(call)) content.push(call);
        continue;
      }
      content.push(part);
    }
  }
  return content;
}

export function collectServerToolCalls(history: Message[], matched: Map<string, { tool: HttpTool; declaration: ServerToolDeclaration }>): ServerToolCall[] {
  const calls: ServerToolCall[] = [];
  for (let index = 0; index < history.length; index++) {
    const message = history[index]!;
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool_use") continue;
      const hit = matched.get(part.name);
      if (!hit) continue;
      const next = history[index + 1];
      const text = next ? toolResultText(next, part.id) : undefined;
      let payload: unknown;
      const isError = next ? resultIsError(next, part.id) : true;
      try { payload = text === undefined ? undefined : JSON.parse(text); }
      catch { payload = text; }
      // The client sees the name it declared, not the operator's bound name.
      calls.push({ name: hit.declaration.name, id: part.id, input: part.input, tool: hit.tool, payload, isError });
    }
  }
  return calls;
}

/**
 * Turn collected calls into the canonical parts a renderer expands into the
 * client's own protocol blocks.
 *
 * A failed call still gets a part, carrying an error code instead of entries: an
 * empty or invented result list would tell the client the search found nothing,
 * which is a different fact from a broken adapter. The code is the adapter's own
 * when it named one, and `unavailable` when it did not.
 */
export function serverToolParts(calls: ServerToolCall[], family: "anthropic" | "openai_responses"): ServerToolResultPart[] {
  return calls.map(call => {
    const contract = call.tool.serverTool!;
    const outcome = call.isError ? { content: [] as [], errorCode: "unavailable" } : serverToolOutcome(call.payload, contract.resultPath);
    return {
      type: "server_tool_result",
      family,
      id: call.id || genId("srvtoolu"),
      name: call.name,
      input: call.input ?? {},
      blockType: contract.resultType,
      content: outcome.content,
      ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
    };
  });
}
