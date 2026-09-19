import { describe, expect, it } from "vitest";
import { AnthropicRequest, AnthropicResponse, buildRequest, buildResponse } from "../src/core/format";
import type { RenderTarget } from "../src/core/ir/request";
import type { Message } from "../src/core/ir/content";
import { fabricateStream } from "../src/core/ir/stream";
import { HttpToolSchema, serverToolOutcome, type HttpTool } from "../src/execution/toolHttp";
import { collectServerToolCalls, hostedServerTools, rewriteServerTools, serverToolParts, serverToolDeclaration } from "../src/execution/serverTools";

const target = (extra: Partial<RenderTarget> = {}): RenderTarget => ({ upstreamModel: "up", ...extra });

/** A bound tool that opts into server-side round trips, and one that does not. */
const bound = (over: Record<string, unknown> = {}): HttpTool => HttpToolSchema.parse({
  name: "search",
  description: "Search the web",
  parameters: { type: "object", properties: { queries: { type: "array", items: { type: "string" } } }, required: ["queries"] },
  url: "https://adapter.example/tools/search",
  bodyTemplate: { arguments: "{{arguments}}" },
  serverTool: { name: "web_search" },
  ...over,
});

const plainTool = (): HttpTool => HttpToolSchema.parse({
  name: "lookup",
  parameters: { type: "object" },
  url: "https://adapter.example/tools/lookup",
  bodyTemplate: { arguments: "{{arguments}}" },
});

const parse = (tools: unknown[]) => AnthropicRequest.parse({ model: "svc", max_tokens: 100, tools, messages: [{ role: "user", content: "q" }] });

describe("server tool declarations", () => {
  it("recognises an Anthropic provider-executed declaration", () => {
    const request = parse([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
    expect(serverToolDeclaration(request.tools![0]!)).toEqual({ name: "web_search", type: "web_search_20250305" });
  });

  it("does not mistake a same-named client tool for a server tool", () => {
    const request = parse([{ name: "web_search", description: "mine", input_schema: { type: "object", properties: {} } }]);
    expect(serverToolDeclaration(request.tools![0]!)).toBeUndefined();
  });

  it("matches a declaration against the tool's own contract, and ignores tools without one", () => {
    const request = parse([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
    // Keyed by the BOUND tool name, so the history collector can find the call.
    expect(hostedServerTools(request.tools, [bound()]).get("search")?.declaration.name).toBe("web_search");

    const request2 = parse([{ type: "web_search_20250305", name: "lookup", max_uses: 5 }]);
    expect(hostedServerTools(request2.tools, [plainTool()]).size).toBe(0);
  });

  it("rewrites a declared server tool into the bound tool the model can actually call", () => {
    const request = parse([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, { name: "my_fn", input_schema: { type: "object", properties: {} } }]);
    const matched = hostedServerTools(request.tools, [bound()]);
    const rewritten = rewriteServerTools(request.tools, matched)!;
    expect(rewritten[0]!.name).toBe("search");
    expect(rewritten[0]!.parameters).toEqual(bound().parameters);
    expect(rewritten[0]!.hosted).toBe(true);
    // The client's own tool is untouched.
    expect(rewritten[1]!.name).toBe("my_fn");
    expect(rewritten[1]!.hosted).toBeUndefined();
  });

  it("passes a request with no declaration through unchanged", () => {
    const request = parse([{ name: "my_fn", input_schema: { type: "object", properties: {} } }]);
    const tools = rewriteServerTools(request.tools, hostedServerTools(request.tools, [bound()]));
    expect(tools![0]!.name).toBe("my_fn");
  });
});

describe("adapter result selection", () => {
  it("selects the declared entry array", () => {
    expect(serverToolOutcome({ results: [{ url: "u" }] }, "/results")).toEqual({ content: [{ url: "u" }] });
  });
  it("takes the whole body when the pointer is empty", () => {
    expect(serverToolOutcome([{ url: "u" }], "")).toEqual({ content: [{ url: "u" }] });
  });
  it("falls back to unavailable when the pointer selects something unusable", () => {
    expect(serverToolOutcome({ results: { url: "u" } }, "/results")).toEqual({ content: [], errorCode: "unavailable" });
    expect(serverToolOutcome({ other: [] }, "/results")).toEqual({ content: [], errorCode: "unavailable" });
    expect(serverToolOutcome("not json", "")).toEqual({ content: [], errorCode: "unavailable" });
  });

  // The adapter owns the failure vocabulary: it says WHY, within the codes the
  // client protocol already understands.
  it("takes the error code the adapter chose", () => {
    expect(serverToolOutcome({ results: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }, "/results"))
      .toEqual({ content: [], errorCode: "max_uses_exceeded" });
  });
  it("substitutes unavailable for a code the protocol does not define", () => {
    expect(serverToolOutcome({ results: { error_code: "my_own_reason" } }, "/results"))
      .toEqual({ content: [], errorCode: "unavailable" });
  });
});

describe("round trip collection", () => {
  const history = (): Message[] => [
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { queries: ["a"] } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: [{ type: "text", text: JSON.stringify([{ url: "https://e.com", title: "E" }]) }] }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
  ];

  it("pairs every provider-executed call with the adapter output it returned", () => {
    const calls = collectServerToolCalls(history(), hostedServerTools(parse([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]).tools, [bound()]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("web_search");
    expect(calls[0]!.id).toBe("toolu_1");
    expect(calls[0]!.isError).toBe(false);
    expect(calls[0]!.payload).toEqual([{ url: "https://e.com", title: "E" }]);
  });

  it("keeps every round of a multi-round run, not just the last", () => {
    const multi: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { queries: ["a"] } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: [{ type: "text", text: JSON.stringify([{ url: "u1" }]) }] }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "search", input: { queries: ["b"] } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_2", content: [{ type: "text", text: JSON.stringify([{ url: "u2" }]) }] }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ];
    const matched = hostedServerTools(parse([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]).tools, [bound()]);
    expect(collectServerToolCalls(multi, matched).map(c => c.id)).toEqual(["toolu_1", "toolu_2"]);
  });

  it("flags a broken adapter result as an error rather than an empty search", () => {
    const broken: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "search", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: [{ type: "text", text: "{}" }], isError: true }] },
    ];
    const matched = hostedServerTools(parse([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]).tools, [bound()]);
    const parts = serverToolParts(collectServerToolCalls(broken, matched), "anthropic");
    expect(parts[0]!.errorCode).toBe("unavailable");
    expect(parts[0]!.content).toEqual([]);
  });
});

describe("Anthropic server tool rendering", () => {
  const parts = serverToolParts(
    collectServerToolCalls([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { queries: ["tokyo"] } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: [{ type: "text", text: JSON.stringify([{ url: "https://e.com", title: "E", snippet: "s" }]) }] }] },
    ], hostedServerTools(parse([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]).tools, [bound()])),
    "anthropic",
  );

  it("renders the provider call and its result, in that order", () => {
    const response = buildResponse("anthropic", { id: "msg_1", model: "svc", created: 0, content: [...parts, { type: "text", text: "answer" }], stopReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    const body = response.renderSelf("svc");
    const content = body.content as Record<string, unknown>[];
    expect(content.map(b => b.type)).toEqual(["server_tool_use", "web_search_result", "text"]);
    expect(content[0]).toEqual({ type: "server_tool_use", id: "toolu_1", name: "web_search", input: { queries: ["tokyo"] }, caller: { type: "direct" } });
    // The adapter's entries pass through verbatim: no field is renamed, added or dropped.
    expect(content[1]).toEqual({ type: "web_search_result", tool_use_id: "toolu_1", caller: { type: "direct" }, content: [{ url: "https://e.com", title: "E", snippet: "s" }] });
    expect(content[2]).toEqual({ type: "text", text: "answer" });
  });

  it("streams the round trip as content blocks instead of only a final message", async () => {
    const response = buildResponse("anthropic", { id: "msg_1", model: "svc", created: 0, content: [...parts, { type: "text", text: "answer" }], stopReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    const frames: string[] = [];
    for await (const frame of AnthropicResponse.serializeStream(fabricateStream(response.data(), Infinity), { model: "svc" })) frames.push(frame);
    const parsed = frames.filter(f => f.startsWith("event:")).map(f => {
      const event = /event: (\S+)/.exec(f)![1];
      const data = JSON.parse(/data: (.*)/.exec(f)![1]);
      return { event, data };
    });
    const starts = parsed.filter(p => p.event === "content_block_start").map(p => p.data.content_block.type);
    expect(starts).toEqual(["server_tool_use", "web_search_result", "text"]);
    const call = parsed.find(p => p.event === "content_block_start" && p.data.content_block.type === "server_tool_use")!;
    expect(call.data.content_block).toEqual({ type: "server_tool_use", id: "toolu_1", name: "web_search", input: { queries: ["tokyo"] }, caller: { type: "direct" } });
    const result = parsed.find(p => p.event === "content_block_start" && p.data.content_block.type === "web_search_result")!;
    expect(result.data.content_block).toEqual({ type: "web_search_result", tool_use_id: "toolu_1", caller: { type: "direct" }, content: [{ url: "https://e.com", title: "E", snippet: "s" }] });
    // Every opened block must be closed, or a strict client drops the message.
    const opened = parsed.filter(p => p.event === "content_block_start").length;
    const closed = parsed.filter(p => p.event === "content_block_stop").length;
    expect(closed).toBe(opened);
  });

  it("renders one web_search_call item on the Responses wire", () => {
    const response = buildResponse("openai_responses", { id: "resp_1", model: "svc", created: 0, content: [...parts, { type: "text", text: "answer" }], stopReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    const output = response.renderSelf("svc").output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["web_search_call", "message"]);
    expect(output[0]).toMatchObject({
      type: "web_search_call",
      status: "completed",
      action: { type: "search", sources: [{ type: "url", url: "https://e.com" }] },
    });
  });

  it("honours a contract that declares another result block type", () => {
    const custom = serverToolParts(
      collectServerToolCalls([
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "search", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_9", content: [{ type: "text", text: JSON.stringify({ results: [{ url: "u" }] }) }] }] },
      ], hostedServerTools(parse([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]).tools, [bound({ serverTool: { name: "web_search", resultType: "web_fetch_result", resultPath: "/results" } })])),
      "anthropic",
    );
    const body = buildResponse("anthropic", { id: "m", model: "svc", created: 0, content: custom, stopReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }).renderSelf("svc");
    expect((body.content as Record<string, unknown>[])[1]!.type).toBe("web_fetch_result");
  });

  // Anthropic's own shape: the result follows the call in the SAME assistant
  // turn, so a client replaying what it received sends one message, not two.
  it("keeps the round trip when a client replays the same-turn form back", () => {
    const replayed = AnthropicRequest.parse({
      model: "svc", max_tokens: 100,
      messages: [
        { role: "assistant", content: [
          { type: "text", text: "Let me search." },
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { queries: ["a"] } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://e.com" }] },
        ] },
        { role: "user", content: "continue" },
      ],
    });
    const parts = replayed.messages[0]!.content.filter(p => p.type === "server_tool_result");
    expect(parts).toHaveLength(1);
    expect((parts[0] as { id: string }).id).toBe("srvtoolu_1");
    expect((parts[0] as { blockType: string }).blockType).toBe("web_search_tool_result");
    expect((parts[0] as { content: unknown[] }).content).toEqual([{ type: "web_search_result", url: "https://e.com" }]);
    // The text that preceded the call is not lost either.
    expect(replayed.messages[0]!.content.some(p => p.type === "text" && p.text === "Let me search.")).toBe(true);
  });

  it("still accepts the split form, where a result arrives in its own message", () => {
    const replayed = AnthropicRequest.parse({
      model: "svc", max_tokens: 100,
      messages: [
        { role: "assistant", content: [{ type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: {} }] },
        { role: "user", content: [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: [{ type: "web_search_result", url: "https://e.com" }] }] },
      ],
    });
    const parts = replayed.messages[0]!.content.filter(p => p.type === "server_tool_result");
    expect(parts).toHaveLength(1);
    expect((parts[0] as { content: unknown[] }).content).toEqual([{ type: "web_search_result", url: "https://e.com" }]);
  });
});

describe("protocol-neutral gating", () => {
  it("replays a declared server tool verbatim to the same family (unchanged behaviour)", () => {
    const request = AnthropicRequest.parse({ model: "svc", max_tokens: 100, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }], messages: [{ role: "user", content: "q" }] });
    expect((request.render(target()).tools as Record<string, unknown>[])[0]).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
  });

  it("drops it cleanly when crossing families (unchanged behaviour)", () => {
    const request = buildRequest("openai_completion", { requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }], tools: [{ name: "web_search", parameters: {}, raw: { family: "anthropic", value: { type: "web_search_20250305", name: "web_search" } } }], params: {}, stream: false });
    expect(request.render(target()).tools).toBeUndefined();
  });
});
