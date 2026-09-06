import type { Tool } from "../core/ir/content";
import type { DispatchableTool, ToolKind } from "../persistence/toolRepo";

/**
 * Who serves each tool in a request.
 *
 * The whole policy is two sentences: Hydrogen touches a tool only to fill a gap
 * the resolved provider left, or where the operator set an explicit override.
 * Everything else passes through and the provider owns it. This module is that
 * rule and nothing else -- no HTTP, no loop, no wire formats -- so the decision
 * can be read and tested on its own.
 */

/** The exact hosted type string a client declared, or undefined for a plain
 * function tool.
 *
 * Read from the verbatim declaration rather than `Tool.name`, because the two
 * differ on the Anthropic wire: `{"type":"web_search_20250305","name":"web_search"}`
 * parses to `name: "web_search"`, while config entries are keyed by the exact
 * type string (S9) precisely so a dated variant can behave differently from its
 * predecessor. Keying on the name would silently merge them.
 */
export function hostedToolType(tool: Tool): string | undefined {
  if (!tool.raw) return undefined;
  const value = tool.raw.value;
  if (!value || typeof value !== "object") return undefined;
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" && type ? type : undefined;
}

/**
 * The hosted tools a given model actually serves.
 *
 * The provider declares what it can do; the mapping may narrow it per model,
 * since one endpoint can front both a tool-capable and a tool-incapable model.
 * Intersected rather than replaced: a mapping can only take capabilities away,
 * never claim one the provider itself does not have.
 */
export function effectiveCapabilities(
  providerCaps: string[] | null | undefined,
  mappingCaps: string[] | null | undefined,
): string[] | null {
  // NULL means "the operator has not said", which is NOT the same as "serves
  // nothing". Every provider row starts undeclared, so collapsing the two would
  // make the first grant added to any service start stripping hosted tools from
  // providers that serve them perfectly well -- a silent capability loss caused
  // by an unrelated setting.
  if (providerCaps == null) return null;
  // `null` inherits; `[]` is a real declaration that this model serves none.
  // Treating both as falsy would silently hand a model the provider's whole
  // list right after an operator declared it serves nothing.
  if (mappingCaps == null) return [...providerCaps];
  const narrow = new Set(mappingCaps);
  return providerCaps.filter((c) => narrow.has(c));
}

export interface ToolLookup {
  /** The configured entry serving `name` for that declaration shape, if any. */
  find(name: string, kind: ToolKind): DispatchableTool | undefined;
}

export type ToolDecision =
  /** Passed upstream untouched; the provider (or the client) owns it. */
  | { outcome: "provider"; tool: Tool }
  /** Hydrogen dispatches it to the operator's endpoint. */
  | { outcome: "dispatch"; tool: Tool; entry: DispatchableTool }
  /** Nobody can serve it. Stripped from the request and recorded. */
  | { outcome: "drop"; tool: Tool; reason: string };

export interface ResolveToolsInput {
  /** Tools the client declared, canonical form. */
  declared?: Tool[];
  /** Free-form tool names granted by the service, agent and stage, unioned. */
  grants?: string[];
  /** Hosted type strings the resolved provider serves for this model. Null or
   * absent = undeclared, so nothing is known and nothing is assumed. */
  capabilities?: string[] | null;
  /** Configured entries. */
  lookup: ToolLookup;
  /** Tool ids this client key may cause to be dispatched. Null = no limit. */
  allowedToolIds?: number[] | null;
}

export interface ResolvedTools {
  decisions: ToolDecision[];
  /** Granted free-form tools, which no client declared, so they arrive as new
   * function tools rather than as a decision about an existing one. */
  granted: Array<{ tool: Tool; entry: DispatchableTool }>;
  /** Every tool that will be dispatched, by the name the model will call. */
  dispatchable: Map<string, DispatchableTool>;
}

function scopeAllows(entry: DispatchableTool, allowed: number[] | null | undefined): boolean {
  return !allowed || allowed.length === 0 || allowed.includes(entry.id);
}

/**
 * Decide who serves each declared tool, and what the grants add.
 *
 * A **hosted** declaration (`{"type":"web_search"}`) is one the client cannot
 * execute itself, so an unserved one is a real gap: the provider serves it when
 * it can, otherwise a configured endpoint does, otherwise it is dropped and
 * logged rather than failing the request -- Codex declares `web_search` on every
 * call whether or not the turn needs it, so refusing would take the service down
 * for a capability most turns never use.
 *
 * A **function** declaration is executed by the client, so it is never a gap and
 * passes straight through. Only an explicit `override` entry takes it away from
 * the client -- which is the one case where an operator has said they want their
 * own endpoint to answer instead.
 */
export function resolveTools(input: ResolveToolsInput): ResolvedTools {
  // Undeclared capabilities: we cannot know whether the provider serves a hosted
  // tool, so we do not act as if it does not. Passing through is what happened
  // before this feature existed, and a wrong guess either strips a working tool
  // or bills the operator for one the provider would have served free.
  const unknownCapabilities = input.capabilities == null;
  const capabilities = new Set(input.capabilities ?? []);
  const decisions: ToolDecision[] = [];
  const dispatchable = new Map<string, DispatchableTool>();

  const dispatch = (tool: Tool, entry: DispatchableTool): void => {
    decisions.push({ outcome: "dispatch", tool, entry });
    dispatchable.set(tool.name, entry);
  };

  for (const tool of input.declared ?? []) {
    const hosted = hostedToolType(tool);

    if (!hosted) {
      // Client-executed. An override entry is the only thing that intercepts it.
      const entry = input.lookup.find(tool.name, "freeform");
      if (entry?.policy === "override" && scopeAllows(entry, input.allowedToolIds)) dispatch(tool, entry);
      else decisions.push({ outcome: "provider", tool });
      continue;
    }

    const entry = input.lookup.find(hosted, "vocabulary");
    const allowed = entry ? scopeAllows(entry, input.allowedToolIds) : false;
    // An undeclared provider is treated as serving it: see above.
    const providerServes = unknownCapabilities || capabilities.has(hosted);

    if (entry && allowed && entry.policy === "override") {
      dispatch(tool, entry);
    } else if (providerServes) {
      decisions.push({ outcome: "provider", tool });
    } else if (entry && allowed) {
      dispatch(tool, entry);
    } else {
      decisions.push({
        outcome: "drop",
        tool,
        reason: entry
          ? `tool "${hosted}" is out of this API key's tool scope, and the provider does not serve it`
          : `no provider capability or configured endpoint can serve tool "${hosted}"`,
      });
    }
  }

  // Grants reach a client that never asked, so they are additions rather than
  // decisions. A name with no configured entry is simply not offered (S2): the
  // model is never told about a capability nothing can serve.
  const granted: ResolvedTools["granted"] = [];
  const seen = new Set(decisions.map((d) => d.tool.name));
  for (const name of new Set(input.grants ?? [])) {
    if (seen.has(name) || dispatchable.has(name)) continue;
    const entry = input.lookup.find(name, "freeform");
    if (!entry || !scopeAllows(entry, input.allowedToolIds)) continue;
    // Empty on purpose: no client declared this tool, so it has no schema of its
    // own and the operator's entry is authoritative. A placeholder
    // `{type:"object",properties:{}}` here has keys, so it would look like a real
    // declaration and shadow the entry's schema, offering the model a tool it
    // cannot call.
    const tool: Tool = { name, parameters: {} };
    granted.push({ tool, entry });
    dispatchable.set(name, entry);
    seen.add(name);
  }

  return { decisions, granted, dispatchable };
}

/**
 * The tools that actually go upstream: passed-through ones untouched, and
 * dispatched or granted ones as plain function declarations the model can call.
 *
 * `describe` is handed the DECLARED tool as well as the entry, and the name it
 * returns must be the one `dispatchable` is keyed by -- the model calls what it
 * was shown, and the loop recognises the call by that name. Those two disagreed
 * once: an Anthropic hosted tool is
 * `{"type":"web_search_20250305","name":"web_search"}`, so the entry is keyed by
 * the type string while the declared tool is named `web_search`. Declaring the
 * entry's name while keying dispatch on the declared one meant the model called
 * a tool the loop did not recognise, and every Anthropic hosted tool was handed
 * to a client that had never asked for a function by that name.
 */
export function toolsForUpstream(
  resolved: ResolvedTools,
  describe: (entry: DispatchableTool, declared?: Tool) => Tool,
): Tool[] {
  const out: Tool[] = [];
  for (const d of resolved.decisions) {
    if (d.outcome === "provider") out.push(d.tool);
    else if (d.outcome === "dispatch") out.push(describe(d.entry, d.tool));
  }
  for (const g of resolved.granted) out.push(describe(g.entry, g.tool));
  return out;
}
