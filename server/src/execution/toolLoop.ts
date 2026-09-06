import type { Message, Tool, ToolResultPart, ToolUsePart } from "../core/ir/content";
import type { Request } from "../core/ir/request";
import type { Response } from "../core/ir/response";
import type { DispatchableTool } from "../persistence/toolRepo";
import type { DispatchDeps } from "./toolDispatch";
import type { ToolLookup } from "./toolPolicy";
import { hostedToolType } from "./toolPolicy";

/** Everything the loop needs beyond the request itself. */
export interface ToolRuntime {
  /** The configured tool entries. */
  lookup: ToolLookup;
  /** Transport (and proxy resolution) for the dispatch call. */
  dispatch: DispatchDeps;
}

/**
 * How a dispatched tool is declared to the upstream.
 *
 * Always a plain function tool, whatever the client called it. The model has to
 * be able to CALL it, and `function` is the one tool shape every wire family
 * models natively -- a hosted type declared to a provider that does not host it
 * is exactly the drop this feature exists to prevent.
 */
export function describeTool(entry: DispatchableTool, declared?: Tool): Tool {
  // The client's own description/schema wins when it sent one -- it is what the
  // client's prompt was written against. A hosted declaration carries neither
  // (there is nothing to describe on `{"type":"web_search"}`), so the operator's
  // entry supplies them; without that the model would be offered a tool with an
  // empty schema and no idea what to pass.
  const declaredParams = declared?.parameters && Object.keys(declared.parameters).length > 0 ? declared.parameters : undefined;
  return {
    name: declared?.name ?? entry.name,
    description: declared?.description ?? entry.description ?? undefined,
    parameters: declaredParams ?? entry.parameters ?? { type: "object", properties: {} },
  };
}

/** True when this request could dispatch anything, so the loop is worth running. */
export function mayDispatch(request: Request, grants: readonly string[], runtime: ToolRuntime | null | undefined): boolean {
  if (!runtime) return false;
  if (grants.length > 0) return true;
  for (const tool of request.tools ?? []) {
    const hosted = hostedToolType(tool);
    if (hosted ? runtime.lookup.find(hosted, "vocabulary") : runtime.lookup.find(tool.name, "freeform")) return true;
  }
  return false;
}

/** The tool calls in a response, split by who is expected to run them. */
export interface SplitCalls {
  ours: ToolUsePart[];
  clients: ToolUsePart[];
}

export function splitToolCalls(response: Response, dispatchable: Map<string, DispatchableTool>): SplitCalls {
  const ours: ToolUsePart[] = [];
  const clients: ToolUsePart[] = [];
  for (const p of response.content) {
    if (p.type !== "tool_use") continue;
    if (dispatchable.has(p.name)) ours.push(p);
    else clients.push(p);
  }
  return { ours, clients };
}

/**
 * Whether the loop should run another round.
 *
 * A turn that calls one of ours AND one of the client's is handed back to the
 * client untouched, rather than dispatching ours first. That is not caution, it
 * is what the vendor does: Anthropic returns `stop_reason: "tool_use"` and does
 * NOT run its server tool when it was called in the same parallel group as a
 * client tool, because the conversation cannot continue until the client has
 * answered its own call anyway. Dispatching ours here would spend the operator's
 * money on a result the very next turn would have to re-derive.
 */
export function shouldContinue(split: SplitCalls): boolean {
  return split.ours.length > 0 && split.clients.length === 0;
}

/**
 * The conversation for the next round: the assistant turn exactly as the model
 * produced it, then the results of the tools we ran.
 *
 * The assistant turn is replayed whole -- text, reasoning and every tool call --
 * because a model that is handed back an edited version of its own turn is being
 * lied to about what it said, and several providers reject a tool result whose
 * call is missing.
 */
export function appendToolTurn(
  request: Request,
  response: Response,
  results: Array<{ call: ToolUsePart; output: string; isError: boolean }>,
): Request {
  const assistant: Message = { role: "assistant", content: [...response.content] };
  const toolResults: ToolResultPart[] = results.map((r) => ({
    type: "tool_result",
    toolUseId: r.call.id,
    content: [{ type: "text", text: r.output }],
    ...(r.isError ? { isError: true } : {}),
  }));
  const next: Message = { role: "user", content: toolResults };
  return request.withMessages([...request.messages, assistant, next]);
}
