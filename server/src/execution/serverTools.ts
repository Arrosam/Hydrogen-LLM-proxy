import { genId } from "../util/ids";
import { isDeepStrictEqual } from "node:util";
import type { ContentPart, Message, ServerToolResultPart, Tool, ToolChoice, ToolResultPart, ToolUsePart } from "../core/ir/content";
import type { Family } from "../core/ir/params";
import type { Request } from "../core/ir/request";
import { buildRequest, parseRequest } from "../core/format/registry";
import { buildErrorBody } from "../core/proxy/errors";
import type { HttpTool } from "./toolHttp";
import { PAUSED_TOOL_MARKER, serverToolOutcome } from "./toolHttp";
import type { ServerToolPolicy } from "./definition";
import type { AttemptFailure } from "./steps";

export const DEFAULT_SERVER_TOOL_NAME_PREFIX = "provider_server_side_";
export const DEFAULT_SERVER_TOOL_POLICY: ServerToolPolicy = { mode: "blacklist", names: [] };
/** Explicit provider spellings, never a heuristic for stripping versions. */
const RESPONSES_SERVER_TOOL_NAMES: Record<string, string> = {
  web_search: "web_search", web_search_preview: "web_search", web_search_preview_2025_03_11: "web_search", web_search_2025_08_26: "web_search", computer_use_preview: "computer",
};
export const SERVER_TOOL_KNOWN_NAMES = ["web_search", "web_fetch", "file_search", "code_interpreter", "computer", "image_generation", "mcp", "bash", "text_editor"] as const;

/** An operator binding is availability only. A prepared map is the authority
 * for a particular model round; names alone never grant local execution. */
export interface ServerToolAvailability { tools: HttpTool[]; prefix?: string; }
export interface HostedServerTool { tool: HttpTool; declaration: ServerToolDeclaration; emittedName: string; }
export type HostedServerTools = Map<string, HostedServerTool>;
/** A real completed operation, separate from a nested service's final product
 * response. Call and result retain exact private authority through parents. */
export interface HostedToolReceipt { call: ToolUsePart; result: ToolResultPart; entry: HostedServerTool; }
export interface ServerToolRuntime {
  matched: HostedServerTools;
  declaredNames: Map<string, string>;
  policy: ServerToolPolicy;
  toolChoice?: ToolChoice;
}
export interface PreparedServerTools extends ServerToolRuntime { request: Request; }

export function combineServerToolAvailability(local: HttpTool[], parent: ServerToolAvailability | undefined, prefix: string): ServerToolAvailability {
  const tools = [...(parent?.tools ?? [])];
  for (const tool of local) if (!tools.some(existing => tool.id != null ? existing.id === tool.id : existing === tool)) tools.push(tool);
  return { tools, prefix: parent?.prefix ?? prefix };
}

/** Local request rejection, using the ingress family's normal error envelope.
 * Only name conflicts have a Hydrogen-specific code. */
export class ServerToolPreflightError extends Error {
  readonly statusCode = 400;
  readonly errorBody: Record<string, unknown>;
  constructor(message: string, family: Family, readonly code?: "hydrogen_tool_name_conflict" | "tool_not_found") {
    super(message);
    this.name = "ServerToolPreflightError";
    this.errorBody = buildErrorBody(family, this.statusCode, message);
    if (code && (code === "hydrogen_tool_name_conflict" || family !== "anthropic")) {
      (this.errorBody.error as Record<string, unknown>).code = code;
    }
  }
  failure(): AttemptFailure {
    return { ok: false, status: this.statusCode, kind: "error", message: this.message, errorBody: this.errorBody, retryable: false, terminal: true };
  }
}

function conflict(name: string, family: Family): never {
  throw new ServerToolPreflightError(`Tool name '${name}' conflicts with another declared or Hydrogen tool`, family, "hydrogen_tool_name_conflict");
}
function notFound(name: string, family: Family): never {
  throw new ServerToolPreflightError(`Tool '${name}' not found`, family, "tool_not_found");
}

/** Validate availability before any model, attachment, or adapter dispatch. */
export function validateServerToolBindings(bound: HttpTool[], family: Family): Map<string, HttpTool> {
  const byDeclared = new Map<string, HttpTool>();
  for (const tool of bound) {
    if (!tool.enabled || !tool.serverTool) continue;
    if (byDeclared.has(tool.serverTool.name)) conflict(tool.serverTool.name, family);
    byDeclared.set(tool.serverTool.name, tool);
  }
  return byDeclared;
}

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
 * Provider wires spell provider-executed tools as a `type` with no schema, and the
 * request parsers keep the raw declaration because a client tool with the same
 * name must NOT be treated as one:
 *
 *   Anthropic  `{ type: "web_search_20250305", name: "web_search" }` — the name
 *              is explicit and may be any provider tool spelling.
 *   Responses  `{ type: "web_search" }` (or `web_search_2025_08_26`) — the type
 *              IS the name; there is no separate field.
 *   Completions extensions retain their exact explicit name or type. Client
 *              `function` and `custom` declarations never enter this path.
 */
export function serverToolDeclaration(tool: Tool): ServerToolDeclaration | undefined {
  if (!tool.raw) return undefined;
  const value = tool.raw.value as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return undefined;
  const type = typeof value.type === "string" ? value.type : "";
  if (!type || type === "function" || type === "custom") return undefined;
  return { name: tool.raw.family === "openai_responses" ? RESPONSES_SERVER_TOOL_NAMES[type] ?? type : typeof value.name === "string" ? value.name : type, type };
}

/**
 * Declarations in the request that are answered by a bound tool's serverTool
 * contract, keyed by the exact EMITTED function name.
 *
 * One key serves both lookups. The history collector finds the call the model
 * made, which must be an explicitly offered emitted name; the rewriter finds the client's
 * declaration, whose name may differ (a client declares `web_search` while the
 * operator bound `search`).
 */
export function hostedServerTools(tools: Tool[] | undefined, bound: HttpTool[], prefix = DEFAULT_SERVER_TOOL_NAME_PREFIX, policy: ServerToolPolicy = DEFAULT_SERVER_TOOL_POLICY, family: Family = "openai_responses"): HostedServerTools {
  const byDeclared = validateServerToolBindings(bound, family);
  const matched: HostedServerTools = new Map();
  for (const tool of tools ?? []) {
    const declaration = serverToolDeclaration(tool);
    if (!declaration) continue;
    // Whitelist bypass takes precedence even when a local adapter is available.
    if (policy.mode === "whitelist" && policy.names.includes(declaration.name)) continue;
    const boundTool = byDeclared.get(declaration.name);
    if (boundTool) {
      const emittedName = prefix + boundTool.name;
      if (matched.has(emittedName)) conflict(emittedName, family);
      matched.set(emittedName, { tool: boundTool, declaration, emittedName });
    } else if (policy.mode === "whitelist" || policy.names.includes(declaration.name)) notFound(declaration.name, family);
  }
  return matched;
}

/** The same matches, indexed by the name the client declared. */
export function declaredServerTools(matched: HostedServerTools): Map<string, HostedServerTool> {
  return new Map([...matched.values()].map(entry => [entry.declaration.name, entry]));
}

/**
 * Rewrite a declared server tool into the real bound tool so the model sees the
 * adapter's own schema — the client's declaration carries no parameters, and
 * without this the model would be handed a tool it cannot call.
 */
export function rewriteServerTools(tools: Tool[] | undefined, matched: HostedServerTools): Tool[] | undefined {
  if (!tools?.length) return tools;
  const byDeclared = declaredServerTools(matched);
  return tools.map(tool => {
    const declaration = serverToolDeclaration(tool);
    const entry = declaration ? byDeclared.get(declaration.name) : undefined;
    if (!entry) return tool;
    return { name: entry.emittedName, description: entry.tool.description, parameters: entry.tool.parameters, hosted: true, ...(tool.cacheControl ? { cacheControl: tool.cacheControl } : {}) };
  });
}

function wireTools(value: unknown, egressFamily: Family, ingressFamily: Family): Tool[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new ServerToolPreflightError("tools must be an array", ingressFamily);
  const parsed = parseRequest(egressFamily, { model: "preflight", messages: [], input: [], tools: value }).tools;
  if ((parsed?.length ?? 0) !== value.length) throw new ServerToolPreflightError("Invalid tool declaration", ingressFamily);
  return parsed;
}
function wireChoice(value: unknown, egressFamily: Family, ingressFamily: Family): ToolChoice | undefined {
  if (value == null) return undefined;
  const choice = parseRequest(egressFamily, { model: "preflight", messages: [], input: [], tool_choice: value }).toolChoice;
  if (!choice) throw new ServerToolPreflightError("Invalid tool_choice", ingressFamily);
  return choice;
}

/** Materialize tool overlays in their egress vocabulary before applying policy.
 * Removing these two fields from extras prevents a later renderer overwrite
 * from replacing the very declaration that established ownership. */
function effectiveTools(request: Request, family: Family): Request {
  const params = structuredClone(request.params);
  let tools = request.tools, toolChoice = request.toolChoice;
  const own = params.passthrough?.family === family ? params.passthrough.params : undefined;
  if (!tools?.length && own && Object.hasOwn(own, "tools")) tools = wireTools(own.tools, family, request.family);
  if (!toolChoice && !(family === "anthropic" && params.parallelToolCalls === false) && own && Object.hasOwn(own, "tool_choice")) {
    toolChoice = wireChoice(own.tool_choice, family, request.family);
  }
  if (params.extra && Object.hasOwn(params.extra, "tools")) tools = wireTools(params.extra.tools, family, request.family);
  if (params.extra && Object.hasOwn(params.extra, "tool_choice")) toolChoice = wireChoice(params.extra.tool_choice, family, request.family);
  if (params.extra) { delete params.extra.tools; delete params.extra.tool_choice; }
  if (own) { delete own.tools; delete own.tool_choice; }
  return buildRequest(request.family, { ...request.data(), tools, toolChoice, params });
}

function allowedChoiceTools(choice: Extract<ToolChoice, { type: "raw" }>): unknown[] | undefined {
  if (choice.value.type !== "allowed_tools") return undefined;
  const nested = choice.family === "openai_completion" ? choice.value.allowed_tools as Record<string, unknown> | undefined : undefined;
  const tools = nested?.tools ?? choice.value.tools;
  return Array.isArray(tools) ? tools : undefined;
}

function nativeChoiceName(value: Record<string, unknown>, family: Family): string {
  if (!value || typeof value !== "object") return "";
  const type = String(value.type ?? "");
  if (family === "openai_responses" && type !== "function" && type !== "custom") return RESPONSES_SERVER_TOOL_NAMES[type] ?? type;
  return String(value.name ?? (value.function as Record<string, unknown> | undefined)?.name ?? (value.custom as Record<string, unknown> | undefined)?.name ?? (family === "openai_responses" ? RESPONSES_SERVER_TOOL_NAMES[type] ?? type : type));
}

function nativeChoiceNames(choice: Extract<ToolChoice, { type: "raw" }>): string[] {
  const value = choice.value;
  const allowed = allowedChoiceTools(choice);
  return allowed ? allowed.map(item => nativeChoiceName(item as Record<string, unknown>, choice.family)) : [nativeChoiceName(value, choice.family)];
}

function rewriteChoice(choice: ToolChoice | undefined, original: Tool[] | undefined, matched: HostedServerTools, family: Family, ingressFamily: Family): ToolChoice | undefined {
  if (!choice) return choice;
  const declared = declaredServerTools(matched);
  if (choice.type === "tool") {
    // A same-named client function retains its own forced selection.
    if (original?.some(tool => !tool.raw && tool.name === choice.name)) return choice;
    const emittedName = declared.get(choice.name)?.emittedName;
    return emittedName ? { type: "tool", name: emittedName } : choice;
  }
  if (choice.type !== "raw") return choice;
  if (choice.value.type === "function" || choice.value.type === "custom") {
    if (choice.family !== family) throw new ServerToolPreflightError(`Native tool_choice from ${choice.family} cannot be sent to ${family}`, ingressFamily);
    return choice;
  }
  if (choice.family !== family && (choice.value.type === "allowed_tools" || !declared.has(nativeChoiceNames(choice)[0]!))) throw new ServerToolPreflightError(`Native tool_choice from ${choice.family} cannot be sent to ${family}`, ingressFamily);
  const allowed = allowedChoiceTools(choice);
  if (allowed) {
    const tools = allowed.map(item => {
      const native = item as Record<string, unknown>;
      // allowed_tools identifies client functions/custom tools explicitly. A
      // same-named server declaration must not take over that selection.
      if (native?.type === "function" || native?.type === "custom") return native;
      const hit = declared.get(nativeChoiceName(native, choice.family));
      return hit ? choice.family === "openai_completion" ? { type: "function", function: { name: hit.emittedName } } : { type: "function", name: hit.emittedName } : native;
    });
    return { ...choice, value: choice.family === "openai_completion" && choice.value.allowed_tools
      ? { ...choice.value, allowed_tools: { ...(choice.value.allowed_tools as Record<string, unknown>), tools } }
      : { ...choice.value, tools } };
  }
  const hit = declared.get(nativeChoiceNames(choice)[0]!);
  return hit ? { type: "tool", name: hit.emittedName } : choice;
}

function validateNames(tools: Tool[] | undefined, family: Family): void {
  const names = new Set<string>();
  for (const tool of tools ?? []) {
    const name = serverToolDeclaration(tool)?.name ?? tool.name;
    if (names.has(name)) conflict(name, family);
    names.add(name);
  }
}
function validateEmittedNames(matched: HostedServerTools, egressFamily: Family, ingressFamily: Family): void {
  const maximum = egressFamily === "anthropic" ? 128 : 64;
  for (const name of matched.keys()) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > maximum) {
      throw new ServerToolPreflightError(`Function name '${name}' is invalid for ${egressFamily}; use letters, digits, underscores or dashes with at most ${maximum} characters`, ingressFamily);
    }
  }
}
function validateChoice(choice: ToolChoice | undefined, tools: Tool[] | undefined, egressFamily: Family, ingressFamily: Family): void {
  if (!choice || choice.type === "auto" || choice.type === "none" || choice.type === "required") return;
  if (choice.type === "tool") {
    if (!tools?.some(tool => !tool.raw && tool.name === choice.name || egressFamily === "anthropic" && serverToolDeclaration(tool)?.name === choice.name)) notFound(choice.name, ingressFamily);
    return;
  }
  const selections = allowedChoiceTools(choice) ?? [choice.value];
  for (const selection of selections) {
    const value = selection as Record<string, unknown>;
    if (!value || typeof value !== "object") throw new ServerToolPreflightError("Invalid tool_choice", ingressFamily);
    const name = nativeChoiceName(value, choice.family);
    const exists = tools?.some(tool => {
      if (value.type === "function") return !tool.raw && tool.name === name;
      if (value.type === "custom") return tool.raw?.value != null && (tool.raw.value as Record<string, unknown>).type === "custom" && tool.name === name;
      return serverToolDeclaration(tool)?.name === name;
    });
    if (!name || !exists) notFound(name, ingressFamily);
  }
}

/** Prepare one upstream step after overrides, preserving ordinary functions.
 * Matching is exact and the result is keyed by the emitted upstream name. */
export function prepareServerTools(request: Request, availability: ServerToolAvailability = { tools: [] }, policy: ServerToolPolicy = DEFAULT_SERVER_TOOL_POLICY, egressFamily: Family = request.family): PreparedServerTools {
  validateServerToolBindings(availability.tools, request.family);
  const effective = effectiveTools(request, egressFamily);
  const matched = hostedServerTools(effective.tools, availability.tools, availability.prefix ?? DEFAULT_SERVER_TOOL_NAME_PREFIX, policy, request.family);
  const tools = rewriteServerTools(effective.tools, matched);
  validateNames(tools, request.family);
  validateEmittedNames(matched, egressFamily, request.family);
  const foreign = tools?.find(tool => tool.raw && tool.raw.family !== egressFamily);
  if (foreign?.raw) throw new ServerToolPreflightError(`Tool '${foreign.name}' from ${foreign.raw.family} cannot be sent to ${egressFamily}`, request.family);
  const toolChoice = rewriteChoice(effective.toolChoice, effective.tools, matched, egressFamily, request.family);
  validateChoice(toolChoice, tools, egressFamily, request.family);
  return {
    request: buildRequest(request.family, { ...effective.data(), tools, toolChoice }),
    matched, declaredNames: new Map([...matched].map(([name, entry]) => [entry.declaration.name, name])),
    policy, toolChoice,
  };
}

/** Check the body the transport will receive after all renderer overlays. This
 * check never acquires local ownership for a function by reading its name. */
export function validateRenderedServerTools(body: Record<string, unknown>, family: Family, prepared: PreparedServerTools): void {
  const tools = wireTools(body.tools, family, prepared.request.family);
  validateNames(tools, prepared.request.family);
  validateEmittedNames(prepared.matched, family, prepared.request.family);
  for (const tool of tools ?? []) {
    const declaration = serverToolDeclaration(tool);
    if (!declaration) continue;
    if (prepared.policy.mode === "whitelist" ? !prepared.policy.names.includes(declaration.name) : prepared.policy.names.includes(declaration.name)) {
      notFound(declaration.name, prepared.request.family);
    }
  }
  for (const name of prepared.matched.keys()) {
    if (!tools?.some(tool => !tool.raw && tool.name === name)) notFound(name, prepared.request.family);
  }
  validateChoice(wireChoice(body.tool_choice, family, prepared.request.family), tools, family, prepared.request.family);
}

/** Saved local calls carry private provenance; provider-native calls do not.
 * Build ordinary function history for the next upstream round without changing
 * the saved/client-facing history or guessing ownership from a prefix. */
export function localToolHistory(messages: Message[]): Message[] {
  return messages.map(message => ({ ...message, content: message.content.map(part => {
    if (part.type !== "tool_use" || !part.hydrogenTool) return part;
    return { ...part, name: part.hydrogenTool.emittedName, serverTool: false };
  }) }));
}

/** Register the exact winning-map entry on a call before executing or pausing. */
export function markLocalToolCall(call: ToolUsePart, entry: HostedServerTool): void {
  const previous = call.hydrogenTool;
  const sameEntry = previous?.id === entry.tool.id && previous?.emittedName === entry.emittedName
    && previous.declaredName === entry.declaration.name && previous.declarationType === entry.declaration.type;
  call.name = entry.emittedName;
  call.serverTool = true;
  call.hydrogenTool = { ...(entry.tool.id != null ? { id: entry.tool.id } : {}), emittedName: entry.emittedName, declaredName: entry.declaration.name, declarationType: entry.declaration.type,
    instanceId: sameEntry && previous?.instanceId ? previous.instanceId : genId("srvexec") };
}

function sameToolProvenance(left: ToolUsePart["hydrogenTool"], right: ToolUsePart["hydrogenTool"]): boolean {
  return !!left && !!right && left.id === right.id && left.emittedName === right.emittedName
    && left.declaredName === right.declaredName && left.declarationType === right.declarationType && left.instanceId === right.instanceId;
}

function resultMatchesCall(result: ToolResultPart, call: ToolUsePart): boolean {
  return result.toolUseId === call.id && (!result.hydrogenTool || sameToolProvenance(result.hydrogenTool, call.hydrogenTool));
}

function callAnswered(history: Message[], call: ToolUsePart): boolean {
  return history.some(message => message.content.some(part => part.type === "tool_result" ? resultMatchesCall(part, call)
    : part.type === "server_tool_result" && !part.notExecuted && part.id === call.id));
}

/** Append only actual receipts for calls the enclosing history already owns.
 * Internal completed child conversations never become new parent content. */
export function retainServerToolReceipts(history: Message[], receipts: readonly HostedToolReceipt[]): HostedToolReceipt[] {
  const retained: HostedToolReceipt[] = [];
  for (const receipt of receipts) {
    const marker = receipt.call.hydrogenTool;
    if (!marker || receipt.call.name !== receipt.entry.emittedName || marker.id !== receipt.entry.tool.id
      || marker.emittedName !== receipt.entry.emittedName || marker.declaredName !== receipt.entry.declaration.name
      || marker.declarationType !== receipt.entry.declaration.type || !sameToolProvenance(marker, receipt.result.hydrogenTool)
      || receipt.result.toolUseId !== receipt.call.id) continue;
    const call = history.flatMap(message => message.content).find((part): part is ToolUsePart => part.type === "tool_use"
      && part.id === receipt.call.id && sameToolProvenance(part.hydrogenTool, marker) && isDeepStrictEqual(part.input, receipt.call.input));
    if (!call || callAnswered(history, call)) continue;
    history.push({ role: "user", content: [structuredClone(receipt.result)] });
    retained.push(receipt);
  }
  return retained;
}

/** Reconstruct an already-authorized pending call from its saved exact identity.
 * A wire-level server_tool_use without private provenance still requires a
 * declaration in the current prepared map. */
export function pendingServerTools(history: Message[], availability: ServerToolAvailability, prepared: ServerToolRuntime): HostedServerTools {
  const matched: HostedServerTools = new Map(prepared.matched);
  const declared = declaredServerTools(prepared.matched);
  for (const message of history) for (const part of message.content) {
    if (part.type !== "tool_use" || part.serverTool !== true) continue;
    const saved = part.hydrogenTool;
    const tool = saved?.id == null ? undefined : availability.tools.find(tool => tool.enabled && tool.id === saved.id && tool.serverTool?.name === saved.declaredName);
    const entry = tool && saved ? { tool, declaration: { name: saved.declaredName, type: saved.declarationType }, emittedName: saved.emittedName }
      : saved ? prepared.matched.get(saved.emittedName) : declared.get(part.name);
    if (!entry) continue;
    markLocalToolCall(part, entry);
    matched.set(entry.emittedName, entry);
  }
  return matched;
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
  /** True when a pause stopped the run before this call was sent anywhere. */
  notExecuted?: boolean;
}

/**
 * Pair every provider-executed call in the run's history with its result, in
 * round order. `history` carries the UNTRUNCATED adapter output for the whole
 * run — unlike the request trace, which is clipped for the log — so this is the
 * one place the client-facing result can be built from real data.
 */
/**
 * Hosted calls a paused turn left unexecuted, paired with their bound tools.
 *
 * A resumed request still carries that turn, so these have to run before the
 * model is asked again — they are the work the pause declined to do. A `tool_use`
 * is pending exactly when no `tool_result` anywhere in the request refers to it.
 */
export function pendingHostedResults(history: Message[], named: Map<string, HttpTool>): ContentPart[] {
  return pendingHostedCalls(history, named).map(part => ({
    type: "tool_result",
    toolUseId: part.id,
    content: [{ type: "text", text: JSON.stringify({ error: { code: PAUSED_TOOL_MARKER, message: "The previous turn ended before this tool ran; it was not executed" } }) }],
    isError: true,
  }));
}

/** Return the exact still-unanswered owned instances. Selecting a batch by the
 * provider call ID alone could replay another child's completed operation. */
export function pendingHostedCalls(history: Message[], named: Map<string, HttpTool>): ToolUsePart[] {
  return history.flatMap(message => message.content).filter((part): part is ToolUsePart => part.type === "tool_use"
    && part.serverTool === true && named.has(part.name) && (!part.hydrogenTool || part.hydrogenTool.id === named.get(part.name)!.id)
    && !callAnswered(history, part));
}

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
  notExecuted: ReadonlySet<string> = new Set(),
): ContentPart[] {
  const byId = new Map(parts.map(part => [part.id, part]));
  const content: ContentPart[] = [];
  // A saved pause can leave its owned call before this turn's prefix. Its
  // result is new content even when a new user message intervenes on resume.
  const pendingPrefixCalls = new Set<string>();
  for (const message of history.slice(0, prefix)) for (const part of message.content) {
    if (message.role === "assistant" && part.type === "tool_use" && part.hydrogenTool && byId.has(part.id)) pendingPrefixCalls.add(part.id);
    if (part.type === "tool_result") pendingPrefixCalls.delete(part.toolUseId);
    if (part.type === "server_tool_result" && !part.notExecuted) pendingPrefixCalls.delete(part.id);
  }
  for (const message of history.slice(prefix)) {
    for (const part of message.content) {
      if (part.type !== "tool_result" || !pendingPrefixCalls.delete(part.toolUseId)) continue;
      const call = byId.get(part.toolUseId)!;
      content.push({ ...call, resultOnly: true });
    }
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "reasoning" && part.redacted) continue;
      if (part.type === "tool_use") {
        // A call this run executed becomes the round trip that replaced it; a
        // client tool call, and a call a pause declined, keep their own shape.
        // "Does a round trip exist for this id" is the only honest test: a name
        // that matches a bound tool does not by itself mean the proxy ran it.
        const call = byId.get(part.id);
        if (!call) content.push(part);
        else if (!content.includes(call)) content.push(notExecuted.has(part.id) ? { ...call, notExecuted: true } : call);
        continue;
      }
      // The result half of a pair whose call was already emitted travels with it.
      if (part.type === "server_tool_result" && content.some(c => c.type === "server_tool_result" && c.id === part.id)) continue;
      content.push(part);
    }
  }
  return content;
}

export function collectServerToolCalls(history: Message[], matched: HostedServerTools): ServerToolCall[] {
  const results = new Map<string, Array<{ index: number; part: ToolResultPart }>>();
  for (let index = 0; index < history.length; index++) for (const part of history[index]!.content) {
    if (part.type !== "tool_result") continue;
    const entries = results.get(part.toolUseId) ?? [];
    entries.push({ index, part });
    results.set(part.toolUseId, entries);
  }
  const calls: ServerToolCall[] = [];
  for (let index = 0; index < history.length; index++) {
    const message = history[index]!;
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool_use") continue;
      if (!part.hydrogenTool) continue;
      const hit = matched.get(part.name);
      if (!hit || part.hydrogenTool.emittedName !== hit.emittedName || part.hydrogenTool.id != null && part.hydrogenTool.id !== hit.tool.id) continue;
      const result = results.get(part.id)?.find(entry => entry.index > index && resultMatchesCall(entry.part, part))?.part;
      const text = result?.content.filter(p => p.type === "text").map(p => p.text).join("");
      let payload: unknown;
      const isError = result ? result.isError === true : true;
      try { payload = text === undefined ? undefined : JSON.parse(text); }
      catch { payload = text; }
      const notExecuted = (payload as { error?: { code?: unknown } } | null)?.error?.code === PAUSED_TOOL_MARKER;
      // The client sees the name it declared, not the operator's bound name.
      calls.push({ name: hit.declaration.name, id: part.id, input: part.input, tool: hit.tool, payload, isError, notExecuted });
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
