/**
 * Namespaced tools across wire families.
 *
 * Only the Responses wire has `namespace`. Hydrogen used to drop the whole
 * group when a step resolved anywhere else, which cost a real Codex client ten
 * of its fourteen tools (measured 2026-09-06: three namespaces, ten members).
 * Members are now declared as ordinary functions under a qualified name, and
 * the calls that come back are split again before the client sees them.
 *
 * The collision is not hypothetical: Codex ships `mcp__cua_repl/js` and
 * `mcp__node_repl/js`, plus two `js_reset`. Flattening on the bare name would
 * silently merge them.
 */
import { describe, expect, it } from "vitest";
import { buildRequest, parseRequest, parseResponse } from "../src/core/format";
import { splitToolName, type Tool } from "../src/core/ir/content";
import { withNamespaces, type StreamEvent } from "../src/core/ir/stream";

type Item = Record<string, unknown>;

/** The three namespaces Codex 0.144.5 actually sends, with their members. */
const NAMESPACES: Item[] = [
  {
    type: "namespace",
    name: "multi_agent_v1",
    description: "Tools for spawning and managing sub-agents.",
    tools: ["close_agent", "resume_agent", "send_input", "spawn_agent", "wait_agent"].map((n) => ({
      type: "function",
      name: n,
      description: `${n} description`,
      parameters: { type: "object", properties: {} },
    })),
  },
  {
    type: "namespace",
    name: "mcp__cua_repl",
    description: "Control native apps or browsers.",
    tools: ["js", "js_reset"].map((n) => ({ type: "function", name: n, parameters: { type: "object", properties: {} } })),
  },
  {
    type: "namespace",
    name: "mcp__node_repl",
    description: "Execute JavaScript in a persistent node_repl.",
    tools: ["js", "js_add_node_module_dir", "js_reset"].map((n) => ({
      type: "function",
      name: n,
      parameters: { type: "object", properties: {} },
    })),
  },
];

const NS_NAMES = ["multi_agent_v1", "mcp__cua_repl", "mcp__node_repl"];

function responsesRequest(over: Record<string, unknown> = {}) {
  return parseRequest("openai_responses", {
    model: "svc",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }, ...NAMESPACES],
    stream: false,
    ...over,
  });
}

function renderTo(family: "anthropic" | "openai_completion" | "openai_responses", req = responsesRequest()) {
  return buildRequest(family, req.data()).render({ upstreamModel: "m" }) as Record<string, unknown>;
}

describe("namespace flattening — declarations", () => {
  it("gives a non-Responses provider every member, qualified", () => {
    const tools = (renderTo("anthropic").tools as Item[]) ?? [];
    const names = tools.map((t) => t.name);
    // The plain function survives untouched...
    expect(names).toContain("shell_command");
    // ...and all ten members arrive qualified.
    expect(names).toContain("multi_agent_v1__spawn_agent");
    expect(names).toContain("mcp__node_repl__js");
    expect(names).toContain("mcp__cua_repl__js");
    expect(names).toHaveLength(11);
  });

  it("keeps colliding member names distinct", () => {
    const names = ((renderTo("openai_completion").tools as Item[]) ?? []).map(
      (t) => (t.function as Item | undefined)?.name,
    );
    expect(names).toContain("mcp__cua_repl__js");
    expect(names).toContain("mcp__node_repl__js");
    expect(names).toContain("mcp__cua_repl__js_reset");
    expect(names).toContain("mcp__node_repl__js_reset");
    // No duplicates: a bare-name flatten would have produced two "js".
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries the member's own description and schema across", () => {
    const tools = (renderTo("anthropic").tools as Item[]) ?? [];
    const spawn = tools.find((t) => t.name === "multi_agent_v1__spawn_agent")!;
    expect(spawn.description).toBe("spawn_agent description");
    expect(spawn.input_schema).toEqual({ type: "object", properties: {} });
  });

  it("replays the namespace verbatim to a Responses provider, without duplicating members", () => {
    const tools = (renderTo("openai_responses").tools as Item[]) ?? [];
    // One plain function + three namespaces, and no flattened member tools.
    expect(tools).toHaveLength(4);
    expect(tools.filter((t) => t.type === "namespace")).toEqual(NAMESPACES);
    expect(tools.some((t) => String(t.name ?? "").includes("__js"))).toBe(false);
  });
});

describe("namespace flattening — prior-turn calls", () => {
  const withHistory = () =>
    responsesRequest({
      input: [
        { role: "user", content: [{ type: "input_text", text: "evaluate 1+1" }] },
        { type: "function_call", name: "js", namespace: "mcp__node_repl", arguments: '{"code":"1+1"}', call_id: "c1" },
        { type: "function_call_output", call_id: "c1", output: "2" },
      ],
    });

  it("re-flattens a replayed call so it matches the declared tool", () => {
    const msgs = (renderTo("anthropic", withHistory()).messages as Item[]) ?? [];
    const blocks = msgs.flatMap((m) => (Array.isArray(m.content) ? (m.content as Item[]) : []));
    const call = blocks.find((b) => b.type === "tool_use")!;
    expect(call.name).toBe("mcp__node_repl__js");
    expect(call.id).toBe("c1");
  });

  it("keeps the namespaced form for a Responses provider", () => {
    const items = (renderTo("openai_responses", withHistory()).input as Item[]) ?? [];
    const call = items.find((i) => i.type === "function_call")!;
    expect(call.name).toBe("js");
    expect(call.namespace).toBe("mcp__node_repl");
  });
});

describe("namespace flattening — splitting the reply", () => {
  it("splits a buffered tool call back into namespace + name", () => {
    const res = parseResponse("anthropic", {
      id: "m1",
      model: "m",
      content: [{ type: "tool_use", id: "c1", name: "mcp__node_repl__js", input: { code: "1+1" } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }).withNamespaces(NS_NAMES);

    const out = (res.render("openai_responses", "svc") as Record<string, unknown>).output as Item[];
    const call = out.find((i) => i.type === "function_call")!;
    expect(call.name).toBe("js");
    expect(call.namespace).toBe("mcp__node_repl");
  });

  it("splits a streamed tool call too", async () => {
    async function* events(): AsyncGenerator<StreamEvent> {
      yield { type: "tool_start", index: 0, id: "c1", name: "mcp__cua_repl__js_reset" };
      yield { type: "tool_args_delta", index: 0, delta: "{}" };
      yield { type: "tool_stop", index: 0 };
    }
    const out: StreamEvent[] = [];
    for await (const e of withNamespaces(events(), NS_NAMES)) out.push(e);
    const start = out[0] as Extract<StreamEvent, { type: "tool_start" }>;
    expect(start.name).toBe("js_reset");
    expect(start.extra?.fields.namespace).toBe("mcp__cua_repl");
  });

  it("leaves a call alone when the request declared no namespaces", () => {
    const res = parseResponse("anthropic", {
      id: "m1",
      model: "m",
      content: [{ type: "tool_use", id: "c1", name: "mcp__node_repl__js", input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(res.withNamespaces([])).toBe(res);
  });
});

describe("splitToolName", () => {
  it("only splits on a namespace that was actually declared", () => {
    // A plain function tool may legitimately contain the separator; guessing at
    // the last "__" would rename it.
    expect(splitToolName("some__tool", NS_NAMES)).toEqual({ name: "some__tool" });
    expect(splitToolName("mcp__node_repl__js", NS_NAMES)).toEqual({ name: "js", namespace: "mcp__node_repl" });
  });

  it("prefers the longest matching namespace", () => {
    expect(splitToolName("a__b__c", ["a", "a__b"])).toEqual({ name: "c", namespace: "a__b" });
  });

  it("does not treat a bare namespace name as a member call", () => {
    expect(splitToolName("mcp__node_repl", NS_NAMES)).toEqual({ name: "mcp__node_repl" });
    expect(splitToolName("mcp__node_repl__", NS_NAMES)).toEqual({ name: "mcp__node_repl__" });
  });
});

describe("round trip", () => {
  it("survives Responses -> non-Responses -> back", () => {
    // Declared to a Chat Completions provider...
    const flat = ((renderTo("openai_completion").tools as Item[]) ?? []).map((t) => (t.function as Item).name as string);
    expect(flat).toContain("mcp__node_repl__js_add_node_module_dir");
    // ...called by that provider, and split back for the client.
    const parsed: Tool[] = responsesRequest().tools ?? [];
    const declared = [...new Set(parsed.map((t) => t.namespace).filter(Boolean))] as string[];
    expect(declared).toEqual(NS_NAMES);
    expect(splitToolName("mcp__node_repl__js_add_node_module_dir", declared)).toEqual({
      name: "js_add_node_module_dir",
      namespace: "mcp__node_repl",
    });
  });
});
