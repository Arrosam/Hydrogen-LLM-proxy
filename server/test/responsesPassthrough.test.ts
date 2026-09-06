/**
 * Same-family Responses passthrough must be lossless.
 *
 * When ingress and egress are both `openai_responses`, translation is the
 * identity function and anything Hydrogen silently discards is a bug the client
 * cannot see and cannot work around. Two classes of loss are pinned here:
 *
 *  - correlation fields on a `function_call` (`namespace` from tool search,
 *    `caller` from programmatic tool calling). Measured 2026-09-06: Codex
 *    replays a namespaced call every turn, and the API rejects one that arrives
 *    without its namespace ("Missing namespace for function_call"), so dropping
 *    it broke the second turn of any conversation that used a namespaced tool.
 *
 *  - whole item types the parser does not model (`tool_search_call`,
 *    `custom_tool_call`, `image_generation_call`, `program`, ...). The Responses
 *    item union is far wider than the four types this format parses.
 *
 * The cross-family tests are the other half of the contract: none of this may
 * leak onto a wire that has no meaning for it.
 */
import { describe, expect, it } from "vitest";
import { buildRequest, parseRequest, parseResponse, parseStream, serializeStream } from "../src/core/format";
import type { StreamEvent } from "../src/core/ir/stream";

type Item = Record<string, unknown>;

/** The measured Codex turn-2 shape: a namespaced call and its output. */
const NAMESPACED_CALL: Item = {
  type: "function_call",
  name: "js",
  namespace: "mcp__node_repl",
  arguments: '{"code":"1+1"}',
  call_id: "call_stub_1",
};

function requestBody(over: Partial<Item> = {}): Record<string, unknown> {
  return {
    model: "svc",
    input: [
      { role: "user", content: [{ type: "input_text", text: "evaluate 1+1" }] },
      NAMESPACED_CALL,
      { type: "function_call_output", call_id: "call_stub_1", output: "2" },
    ],
    stream: false,
    ...over,
  };
}

function renderResponses(body: Record<string, unknown>): Record<string, unknown> {
  return parseRequest("openai_responses", body).render({ upstreamModel: "real-model" }) as Record<string, unknown>;
}

function inputItems(rendered: Record<string, unknown>): Item[] {
  return (rendered.input as Item[]) ?? [];
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

async function* sse(frames: string[]): AsyncGenerator<string> {
  for (const f of frames) yield f;
}

describe("Responses passthrough — correlation fields on function_call", () => {
  it("replays `namespace` on the request leg", () => {
    const fc = inputItems(renderResponses(requestBody())).find((i) => i.type === "function_call");
    expect(fc).toBeDefined();
    expect(fc!.namespace).toBe("mcp__node_repl");
    expect(fc!.name).toBe("js");
    expect(fc!.call_id).toBe("call_stub_1");
    expect(fc!.arguments).toBe('{"code":"1+1"}');
  });

  it("replays a field it has never heard of", () => {
    // The whole point of subtracting modelled keys rather than allowlisting:
    // a vendor can add a correlation field and replay keeps working.
    const body = requestBody({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { ...NAMESPACED_CALL, caller: "prog_123", some_future_field: { nested: true } },
      ],
    });
    const fc = inputItems(renderResponses(body)).find((i) => i.type === "function_call")!;
    expect(fc.caller).toBe("prog_123");
    expect(fc.some_future_field).toEqual({ nested: true });
    expect(fc.namespace).toBe("mcp__node_repl");
  });

  it("carries them on the response leg too", () => {
    const res = parseResponse("openai_responses", {
      id: "resp_1",
      model: "m",
      output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "js", namespace: "mcp__node_repl", arguments: "{}", status: "completed" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const out = (res.render("openai_responses", "svc") as Record<string, unknown>).output as Item[];
    const fc = out.find((i) => i.type === "function_call")!;
    expect(fc.namespace).toBe("mcp__node_repl");
  });

  it("does NOT leak them onto another wire", () => {
    const canonical = parseRequest("openai_responses", requestBody()).data();
    for (const family of ["anthropic", "openai_completion"] as const) {
      const rendered = JSON.stringify(buildRequest(family, canonical).render({ upstreamModel: "m" }));
      expect(rendered).not.toContain("namespace");
      expect(rendered).not.toContain("mcp__node_repl");
    }
  });
});

describe("Responses passthrough — unmodelled item types", () => {
  const EXOTIC: Item[] = [
    { type: "tool_search_call", execution: "server", call_id: null, status: "completed", arguments: { paths: ["crm"] } },
    { type: "tool_search_output", execution: "server", call_id: null, status: "completed", tools: [{ type: "namespace", name: "crm", tools: [] }] },
    { type: "custom_tool_call", call_id: "c1", input: "raw text" },
    { type: "image_generation_call", id: "ig_1", result: "base64...", revised_prompt: "a cat" },
    { type: "local_shell_call", call_id: "ls_1", action: { command: ["ls"] } },
    { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "get_customer" }] },
    { type: "program", call_id: "p1", fingerprint: "abc", code: "await tools.x()" },
  ];

  it("round-trips every one of them, unchanged and in order", () => {
    const body = requestBody({
      input: [{ role: "user", content: [{ type: "input_text", text: "go" }] }, ...EXOTIC],
    });
    const items = inputItems(renderResponses(body));
    for (const original of EXOTIC) {
      const match = items.find((i) => i.type === original.type);
      expect(match, `missing item ${String(original.type)}`).toBeDefined();
      expect(match).toEqual(original);
    }
    // Order relative to the user message is preserved.
    const types = items.map((i) => i.type ?? "message");
    expect(types.indexOf("tool_search_call")).toBeLessThan(types.indexOf("tool_search_output"));
    expect(types.indexOf("program")).toBe(types.length - 1);
  });

  it("round-trips unmodelled OUTPUT items from an upstream", () => {
    const upstream: Item[] = [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { query: "hydrogen" } },
      { type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: [] }] },
      { type: "image_generation_call", id: "ig_1", result: "b64", revised_prompt: "a cat" },
    ];
    const res = parseResponse("openai_responses", { id: "r", model: "m", output: upstream, usage: { input_tokens: 1, output_tokens: 1 } });
    const out = (res.render("openai_responses", "svc") as Record<string, unknown>).output as Item[];
    expect(out.find((i) => i.type === "web_search_call")).toEqual(upstream[0]);
    expect(out.find((i) => i.type === "image_generation_call")).toEqual(upstream[2]);
    expect(out.find((i) => i.type === "message")).toBeDefined();
  });

  it("does NOT leak them onto another wire", () => {
    const canonical = parseRequest("openai_responses", requestBody({
      input: [{ role: "user", content: [{ type: "input_text", text: "go" }] }, ...EXOTIC],
    })).data();
    for (const family of ["anthropic", "openai_completion"] as const) {
      const rendered = JSON.stringify(buildRequest(family, canonical).render({ upstreamModel: "m" }));
      for (const t of ["tool_search_call", "custom_tool_call", "image_generation_call", "local_shell_call", "program"]) {
        expect(rendered, `${t} leaked into ${family}`).not.toContain(t);
      }
    }
  });
});

describe("Responses passthrough — the full tool union", () => {
  // Every `type` in the Responses tools union, as of 2026-09-06.
  const TOOLS: Item[] = [
    { type: "function", name: "f", parameters: { type: "object" } },
    { type: "custom", name: "c", format: { type: "text" } },
    { type: "namespace", name: "crm", description: "crm", tools: [{ type: "function", name: "get", parameters: { type: "object" } }] },
    { type: "tool_search" },
    { type: "programmatic_tool_calling" },
    { type: "apply_patch" },
    { type: "shell" },
    { type: "local_shell" },
    { type: "code_interpreter", container: { type: "auto" } },
    { type: "web_search", external_web_access: false },
    { type: "web_search_2025_08_26" },
    { type: "web_search_preview", search_context_size: "medium" },
    { type: "web_search_preview_2025_03_11" },
    { type: "file_search", vector_store_ids: ["vs_1"] },
    { type: "image_generation", quality: "high" },
    { type: "computer" },
    { type: "computer_use_preview", display_width: 1024 },
    { type: "mcp", server_label: "s", server_url: "https://example.invalid" },
  ];

  it("replays all 18 types unchanged", () => {
    const rendered = renderResponses(requestBody({ tools: TOOLS }));
    expect(rendered.tools).toEqual(TOOLS);
  });
});

describe("Responses passthrough — streaming", () => {
  it("carries `namespace` from upstream stream to client stream", async () => {
    const frames = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "m", output: [] } })}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_1", type: "function_call", status: "in_progress", call_id: "call_1", name: "js", namespace: "mcp__node_repl", arguments: "" },
      })}\n\n`,
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"code":"1+1"}' })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "js", namespace: "mcp__node_repl", arguments: '{"code":"1+1"}' },
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", model: "m", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
    ];

    const events = await collect(parseStream("openai_responses", sse(frames)));
    const start = events.find((e) => e.type === "tool_start") as Extract<StreamEvent, { type: "tool_start" }>;
    expect(start).toBeDefined();
    expect(start.extra?.family).toBe("openai_responses");
    expect(start.extra?.fields.namespace).toBe("mcp__node_repl");

    async function* replay(): AsyncGenerator<StreamEvent> {
      for (const e of events) yield e;
    }
    const out = (await collect(serializeStream("openai_responses", replay(), { model: "svc" }))).join("");
    expect(out).toContain('"namespace":"mcp__node_repl"');
  });
});
