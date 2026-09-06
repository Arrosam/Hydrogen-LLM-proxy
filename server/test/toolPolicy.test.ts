/**
 * Who serves each tool.
 *
 * The rule under test is two sentences: Hydrogen touches a tool only to fill a
 * gap the resolved provider left, or where the operator set an explicit
 * override; everything else passes through. Most of the cases below exist
 * because a plausible-sounding reading of that rule is wrong in a way that
 * either steals a tool from the client or offers one nothing can serve.
 */
import { describe, expect, it } from "vitest";
import { parseRequest } from "../src/core/format";
import type { Tool } from "../src/core/ir/content";
import type { DispatchableTool, ToolKind } from "../src/persistence/toolRepo";
import { effectiveCapabilities, hostedToolType, resolveTools, type ToolLookup } from "../src/execution/toolPolicy";

function entry(over: Partial<DispatchableTool> & { id: number; name: string }): DispatchableTool {
  return {
    kind: "freeform",
    endpointUrl: "https://tools.invalid/x",
    headers: {},
    policy: "prefer_provider",
    maxUses: 8,
    timeoutMs: 30_000,
    proxyId: null,
    ...over,
  };
}

/** A lookup over a fixed set of configured entries. */
function lookupOf(...entries: DispatchableTool[]): ToolLookup {
  return { find: (name, kind) => entries.find((e) => e.name === name && e.kind === kind) };
}

const NO_TOOLS: ToolLookup = { find: () => undefined };

/** Canonical tools as the real parsers produce them, not hand-built. */
function declaredFrom(body: Record<string, unknown>, family: "openai_responses" | "anthropic" = "openai_responses"): Tool[] {
  return parseRequest(family, { model: "svc", ...body }).tools ?? [];
}

const RESPONSES_TOOLS = declaredFrom({
  input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  tools: [
    { type: "web_search", external_web_access: false },
    { type: "function", name: "shell_command", parameters: { type: "object" } },
  ],
});

describe("hostedToolType", () => {
  it("reads the exact type string, which is not the tool's name on every wire", () => {
    // Anthropic sends both: type is the dated variant, name is the generic one.
    const anthropic = declaredFrom(
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      },
      "anthropic",
    );
    expect(anthropic[0]!.name).toBe("web_search");
    // Keying config on the name would merge the dated variants, which behave
    // differently -- _20260209 filters results before they reach the context.
    expect(hostedToolType(anthropic[0]!)).toBe("web_search_20250305");
  });

  it("is undefined for an ordinary function tool", () => {
    expect(hostedToolType(RESPONSES_TOOLS.find((t) => t.name === "shell_command")!)).toBeUndefined();
  });
});

describe("effectiveCapabilities", () => {
  it("uses the provider's list when the mapping does not narrow it", () => {
    expect(effectiveCapabilities(["web_search", "code_interpreter"], null)).toEqual(["web_search", "code_interpreter"]);
  });

  it("narrows per model, because one endpoint fronts several models", () => {
    expect(effectiveCapabilities(["web_search", "code_interpreter"], ["web_search"])).toEqual(["web_search"]);
  });

  it("cannot claim a capability the provider itself lacks", () => {
    expect(effectiveCapabilities(["web_search"], ["web_search", "code_interpreter"])).toEqual(["web_search"]);
  });

  it("reports an undeclared provider as UNKNOWN, not as serving nothing", () => {
    // Every provider row starts undeclared. Collapsing "not said" into "none"
    // would make the first grant added to any service start stripping hosted
    // tools from providers that serve them perfectly well.
    expect(effectiveCapabilities(null, null)).toBeNull();
    expect(effectiveCapabilities(undefined, ["web_search"])).toBeNull();
    // An explicit empty list still means "serves none".
    expect(effectiveCapabilities([], null)).toEqual([]);
  });
});

describe("hosted tools — gap filling", () => {
  it("leaves it to the provider when the provider serves it", () => {
    const r = resolveTools({
      declared: RESPONSES_TOOLS,
      capabilities: ["web_search"],
      lookup: lookupOf(entry({ id: 1, name: "web_search", kind: "vocabulary" })),
    });
    expect(r.decisions.find((d) => d.tool.name === "web_search")!.outcome).toBe("provider");
    expect(r.dispatchable.size).toBe(0);
  });

  it("dispatches when the provider cannot serve it", () => {
    const r = resolveTools({
      declared: RESPONSES_TOOLS,
      capabilities: [],
      lookup: lookupOf(entry({ id: 1, name: "web_search", kind: "vocabulary" })),
    });
    const d = r.decisions.find((x) => x.tool.name === "web_search")!;
    expect(d.outcome).toBe("dispatch");
    expect(r.dispatchable.get("web_search")!.id).toBe(1);
  });

  it("takes it from a capable provider when the operator said override", () => {
    const r = resolveTools({
      declared: RESPONSES_TOOLS,
      capabilities: ["web_search"],
      lookup: lookupOf(entry({ id: 1, name: "web_search", kind: "vocabulary", policy: "override" })),
    });
    expect(r.decisions.find((x) => x.tool.name === "web_search")!.outcome).toBe("dispatch");
  });

  it("drops and explains when nobody can serve it, rather than failing", () => {
    // Codex declares web_search on every request whether the turn needs it or
    // not, so refusing here would take the whole service down.
    const r = resolveTools({ declared: RESPONSES_TOOLS, capabilities: [], lookup: NO_TOOLS });
    const d = r.decisions.find((x) => x.tool.name === "web_search")!;
    expect(d.outcome).toBe("drop");
    expect(d.outcome === "drop" && d.reason).toContain("web_search");
  });

  it("keys on the exact type string, so a dated variant is a different tool", () => {
    const anthropic = declaredFrom(
      { messages: [{ role: "user", content: "hi" }], max_tokens: 16, tools: [{ type: "web_search_20260209", name: "web_search" }] },
      "anthropic",
    );
    // An entry for the OLDER variant must not serve the newer one.
    const r = resolveTools({
      declared: anthropic,
      capabilities: [],
      lookup: lookupOf(entry({ id: 1, name: "web_search_20250305", kind: "vocabulary" })),
    });
    expect(r.decisions[0]!.outcome).toBe("drop");
  });
});

describe("function tools — the client owns them", () => {
  it("passes a client-declared function through untouched", () => {
    // Not a gap: the client executes it. Intercepting would steal the call.
    const r = resolveTools({
      declared: RESPONSES_TOOLS,
      capabilities: [],
      lookup: lookupOf(entry({ id: 1, name: "shell_command" })),
    });
    expect(r.decisions.find((d) => d.tool.name === "shell_command")!.outcome).toBe("provider");
    expect(r.dispatchable.has("shell_command")).toBe(false);
  });

  it("intercepts one only on an explicit override", () => {
    const r = resolveTools({
      declared: RESPONSES_TOOLS,
      capabilities: [],
      lookup: lookupOf(entry({ id: 1, name: "shell_command", policy: "override" })),
    });
    expect(r.decisions.find((d) => d.tool.name === "shell_command")!.outcome).toBe("dispatch");
  });

  it("does not let a hosted entry answer a function of the same name", () => {
    // {"type":"web_search"} and {"type":"function","name":"web_search"} are
    // different tools; the wire shape decides which entry applies.
    const fnOnly = declaredFrom({
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "web_search", parameters: { type: "object" } }],
    });
    const r = resolveTools({
      declared: fnOnly,
      capabilities: [],
      lookup: lookupOf(entry({ id: 1, name: "web_search", kind: "vocabulary", policy: "override" })),
    });
    expect(r.decisions[0]!.outcome).toBe("provider");
  });
});

describe("grants", () => {
  it("adds a granted tool the client never asked for", () => {
    const r = resolveTools({ grants: ["check_inventory"], lookup: lookupOf(entry({ id: 7, name: "check_inventory" })) });
    expect(r.granted.map((g) => g.tool.name)).toEqual(["check_inventory"]);
    expect(r.dispatchable.get("check_inventory")!.id).toBe(7);
  });

  it("does not offer a grant with no configured endpoint", () => {
    // S2: the model is never told about a capability nothing can serve.
    const r = resolveTools({ grants: ["check_inventory"], lookup: NO_TOOLS });
    expect(r.granted).toEqual([]);
    expect(r.dispatchable.size).toBe(0);
  });

  it("does not duplicate a tool the client already declared", () => {
    const r = resolveTools({
      declared: RESPONSES_TOOLS,
      grants: ["shell_command"],
      capabilities: [],
      lookup: lookupOf(entry({ id: 1, name: "shell_command" })),
    });
    expect(r.granted).toEqual([]);
  });

  it("unions duplicates from several levels into one", () => {
    // client ∪ agent ∪ stage ∪ service, so the same name arrives repeatedly.
    const r = resolveTools({
      grants: ["check_inventory", "check_inventory"],
      lookup: lookupOf(entry({ id: 7, name: "check_inventory" })),
    });
    expect(r.granted).toHaveLength(1);
  });
});

describe("client key tool scope", () => {
  const scoped = (allowedToolIds: number[] | null) =>
    resolveTools({
      declared: RESPONSES_TOOLS,
      capabilities: [],
      lookup: lookupOf(entry({ id: 1, name: "web_search", kind: "vocabulary" })),
      allowedToolIds,
    });

  it("dispatches when the key allows the tool", () => {
    expect(scoped([1]).decisions.find((d) => d.tool.name === "web_search")!.outcome).toBe("dispatch");
  });

  it("drops when the key does not, and says why", () => {
    const d = scoped([99]).decisions.find((x) => x.tool.name === "web_search")!;
    expect(d.outcome).toBe("drop");
    expect(d.outcome === "drop" && d.reason).toContain("tool scope");
  });

  it("treats an empty or null scope as no limit", () => {
    expect(scoped(null).decisions.find((d) => d.tool.name === "web_search")!.outcome).toBe("dispatch");
    expect(scoped([]).decisions.find((d) => d.tool.name === "web_search")!.outcome).toBe("dispatch");
  });

  it("withholds a granted tool from a key outside its scope", () => {
    const r = resolveTools({
      grants: ["check_inventory"],
      lookup: lookupOf(entry({ id: 7, name: "check_inventory" })),
      allowedToolIds: [1],
    });
    expect(r.granted).toEqual([]);
  });
});

describe("regressions", () => {
  it("passes a hosted tool through when capabilities were never declared", () => {
    // Undeclared is not "serves nothing". Before this, adding an unrelated grant
    // to a service made every request through it strip the client's hosted tool
    // from a provider that would have served it.
    const r = resolveTools({ declared: RESPONSES_TOOLS, capabilities: null, lookup: NO_TOOLS });
    expect(r.decisions.find((d) => d.tool.name === "web_search")!.outcome).toBe("provider");
  });

  it("does not bill the operator for a tool the provider might serve", () => {
    // With capabilities unknown and a prefer_provider entry configured, the
    // provider keeps the tool: dispatching would spend money on a capability
    // that may already be included.
    const r = resolveTools({
      declared: RESPONSES_TOOLS,
      capabilities: null,
      lookup: lookupOf(entry({ id: 1, name: "web_search", kind: "vocabulary" })),
    });
    expect(r.decisions.find((d) => d.tool.name === "web_search")!.outcome).toBe("provider");
  });

  it("still honours an explicit override when capabilities are unknown", () => {
    const r = resolveTools({
      declared: RESPONSES_TOOLS,
      capabilities: null,
      lookup: lookupOf(entry({ id: 1, name: "web_search", kind: "vocabulary", policy: "override" })),
    });
    expect(r.decisions.find((d) => d.tool.name === "web_search")!.outcome).toBe("dispatch");
  });

  it("gives a granted tool no schema of its own, so the entry's is used", () => {
    // A placeholder {type:"object",properties:{}} has keys, so it would look
    // like a real client declaration and shadow the operator's real schema.
    const r = resolveTools({ grants: ["check_inventory"], lookup: lookupOf(entry({ id: 7, name: "check_inventory" })) });
    expect(r.granted[0]!.tool.parameters).toEqual({});
  });
});

describe("mapping capability narrowing", () => {
  it("treats an EMPTY mapping list as 'this model serves none', not as inherit", () => {
    // null inherits the provider's list; [] is a real declaration. Treating both
    // as falsy would hand a model the provider's whole list immediately after an
    // operator declared that this particular model serves nothing.
    expect(effectiveCapabilities(["web_search"], [])).toEqual([]);
    expect(effectiveCapabilities(["web_search"], null)).toEqual(["web_search"]);
  });

  it("passes a hosted tool to the endpoint when the model was declared incapable", () => {
    const r = resolveTools({
      declared: RESPONSES_TOOLS,
      capabilities: effectiveCapabilities(["web_search"], []),
      lookup: lookupOf(entry({ id: 1, name: "web_search", kind: "vocabulary" })),
    });
    // Inheriting instead would have sent it upstream to a model that 400s on it.
    expect(r.decisions.find((d) => d.tool.name === "web_search")!.outcome).toBe("dispatch");
  });
});
