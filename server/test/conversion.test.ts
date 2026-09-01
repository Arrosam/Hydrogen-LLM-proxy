/**
 * Format-conversion fidelity (roadmap F2, F4-F15): what each wire family
 * preserves, adapts, or deliberately drops when a request crosses families.
 * One test per roadmap item, named by it.
 */
import { describe, expect, it } from "vitest";
import { AnthropicRequest, AnthropicResponse, OpenAICompletionRequest, OpenAICompletionResponse, OpenAIResponsesRequest } from "../src/core/format";
import type { RenderTarget } from "../src/core/ir/request";
import type { StreamEvent } from "../src/core/ir/stream";

const target = (extra: Partial<RenderTarget> = {}): RenderTarget => ({ upstreamModel: "up", ...extra });

async function* sse(frames: string[]): AsyncGenerator<string> {
  for (const f of frames) yield f;
}
async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("F2: server-side / non-function tools", () => {
  const anthReq = AnthropicRequest.parse({
    model: "svc", max_tokens: 100,
    tools: [
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      { name: "my_fn", input_schema: { type: "object", properties: {} } },
    ],
    messages: [{ role: "user", content: "q" }],
  });

  it("replays an Anthropic server tool verbatim to the same family", () => {
    const tools = anthReq.render(target()).tools as Record<string, unknown>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
    expect(tools[1].input_schema).toBeDefined();
  });

  it("drops it cleanly when crossing families — never an empty-schema client tool", () => {
    const body = OpenAICompletionRequest.construct(anthReq).render(target());
    const tools = body.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(1); // only my_fn
    expect(JSON.stringify(tools)).not.toContain("web_search");
  });

  it("keeps OpenAI built-in tools verbatim on their own families", () => {
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      tools: [{ type: "web_search" }, { type: "function", name: "f", parameters: { type: "object" } }],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "q" }] }],
    });
    const tools = req.render(target()).tools as Record<string, unknown>[];
    expect(tools[0]).toEqual({ type: "web_search" });
    const anth = AnthropicRequest.construct(req).render(target()).tools as Record<string, unknown>[];
    expect(anth).toHaveLength(1); // web_search dropped, f kept
  });
});

describe("F4: files/PDFs cross families", () => {
  const anthWithDoc = AnthropicRequest.parse({
    model: "svc", max_tokens: 100,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERGLQ==" }, title: "report.pdf" },
      { type: "text", text: "summarize" },
    ] }],
  });

  it("anthropic document -> responses input_file", () => {
    const input = OpenAIResponsesRequest.construct(anthWithDoc).render(target()).input as Record<string, unknown>[];
    const content = (input[0] as { content: Record<string, unknown>[] }).content;
    const file = content.find((c) => c.type === "input_file")!;
    expect(file.filename).toBe("report.pdf");
    expect(String(file.file_data)).toContain("data:application/pdf;base64,UERGLQ==");
  });

  it("anthropic document -> completions file part, and back", () => {
    const body = OpenAICompletionRequest.construct(anthWithDoc).render(target());
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    const file = content.find((c) => c.type === "file")! as { file: { filename: string; file_data: string } };
    expect(file.file.filename).toBe("report.pdf");
    // Parse the completions wire back and render to anthropic again.
    const reparsed = OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content }] });
    const anth = AnthropicRequest.construct(reparsed).render(target());
    const blocks = (anth.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    const doc = blocks.find((b) => b.type === "document")! as { source: { data: string } };
    expect(doc.source.data).toBe("UERGLQ==");
  });
});

describe("F5: tool_result images cross to OpenAI families", () => {
  const anthLoop = AnthropicRequest.parse({
    model: "svc", max_tokens: 100,
    messages: [
      { role: "user", content: "click it" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [
        { type: "text", text: "done" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
      ] }] },
    ],
  });

  it("completions egress: tool message stays text, image rides a follow-up user message", () => {
    const msgs = OpenAICompletionRequest.construct(anthLoop).render(target()).messages as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toBe("done");
    const follow = msgs[msgs.indexOf(toolMsg) + 1] as { role: string; content: Array<Record<string, unknown>> };
    expect(follow.role).toBe("user");
    expect(JSON.stringify(follow.content)).toContain("data:image/png;base64,aW1n");
  });

  it("responses egress: function_call_output stays text, image rides a follow-up message", () => {
    const input = OpenAIResponsesRequest.construct(anthLoop).render(target()).input as Array<Record<string, unknown>>;
    const out = input.find((i) => i.type === "function_call_output")!;
    expect(out.output).toBe("done");
    const follow = input[input.indexOf(out) + 1] as { role: string; content: Array<Record<string, unknown>> };
    expect(follow.role).toBe("user");
    expect(follow.content.some((c) => c.type === "input_image")).toBe(true);
  });
});

describe("F6: thinking signatures stream through", () => {
  it("captures signature_delta and replays it on the way out", async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"up","usage":{"input_tokens":5}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG=="}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const events = await collect(AnthropicResponse.parseStream(sse(frames) as AsyncIterable<string>));
    const stop = events.find((e) => e.type === "reasoning_stop") as Extract<StreamEvent, { type: "reasoning_stop" }>;
    expect(stop.signature).toBe("SIG==");

    async function* replay(): AsyncGenerator<StreamEvent> { for (const ev of events) yield ev; }
    let wire = "";
    for await (const chunk of AnthropicResponse.serializeStream(replay(), { model: "svc" })) wire += chunk;
    expect(wire).toContain('"signature_delta"');
    expect(wire).toContain("SIG==");
  });
});

describe("F7: cache_control survives same-family replay", () => {
  it("keeps breakpoints on message blocks and tool definitions", () => {
    const req = AnthropicRequest.parse({
      model: "svc", max_tokens: 100,
      tools: [{ name: "f", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "long context", cache_control: { type: "ephemeral" } }] }],
    });
    const body = req.render(target());
    expect(JSON.stringify((body.messages as unknown[])[0])).toContain('"cache_control"');
    expect(JSON.stringify((body.tools as unknown[])[0])).toContain('"cache_control"');
  });
});

describe("F8: redacted_thinking round-trips untouched", () => {
  const req = AnthropicRequest.parse({
    model: "svc", max_tokens: 100,
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [
        { type: "redacted_thinking", data: "OPAQUE" },
        { type: "tool_use", id: "t1", name: "f", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] },
    ],
  });

  it("same family: original bytes, original block type", () => {
    const blocks = (req.render(target()).messages as Array<{ content: Array<Record<string, unknown>> }>)[1].content;
    expect(blocks[0]).toEqual({ type: "redacted_thinking", data: "OPAQUE" });
  });

  it("cross family: dropped, never rendered as fake reasoning text", () => {
    const body = OpenAICompletionRequest.construct(req).render(target());
    expect(JSON.stringify(body)).not.toContain("redacted");
    expect(JSON.stringify(body)).not.toContain("OPAQUE");
  });
});

describe("F9-F12: parameter adaptation toward Anthropic", () => {
  it("clamps OpenAI-range temperature into Anthropic's 0..1", () => {
    const req = OpenAICompletionRequest.parse({ model: "svc", temperature: 1.5, messages: [{ role: "user", content: "q" }] });
    expect(AnthropicRequest.construct(req).render(target()).temperature).toBe(1);
  });

  it("clamps completions stop sequences to the wire's maximum of 4", () => {
    const req = AnthropicRequest.parse({ model: "svc", max_tokens: 10, stop_sequences: ["a", "b", "c", "d", "e"], messages: [{ role: "user", content: "q" }] });
    expect((OpenAICompletionRequest.construct(req).render(target()).stop as string[]).length).toBe(4);
  });

  it("F10: a JSON response_format becomes an explicit system instruction", () => {
    const req = OpenAICompletionRequest.parse({ model: "svc", response_format: { type: "json_object" }, messages: [{ role: "user", content: "q" }] });
    const body = AnthropicRequest.construct(req).render(target());
    expect(String(body.system)).toContain("JSON");
  });

  it("F11: a missing max_tokens is left missing, cap or no cap", () => {
    // This wire requires max_tokens and the OpenAI one does not, so an OpenAI
    // client that omitted it produces a request Anthropic will reject. That
    // rejection names the field; a substituted number would name nothing and
    // truncate the answer at a length nobody chose -- including the provider
    // cap, which is the most the upstream allows, not what this caller wanted.
    const req = OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content: "q" }] });
    expect(AnthropicRequest.construct(req).render(target({ providerMaxOutputTokens: 30_000 }))).not.toHaveProperty("max_tokens");
    expect(AnthropicRequest.construct(req).render(target())).not.toHaveProperty("max_tokens");
  });

  it("F12: user maps to metadata.user_id without clobbering client metadata", () => {
    const req = OpenAICompletionRequest.parse({ model: "svc", user: "u-42", messages: [{ role: "user", content: "q" }] });
    const body = AnthropicRequest.construct(req).render(target());
    expect((body.metadata as { user_id: string }).user_id).toBe("u-42");
  });
});

describe("F13-F15: fields kept for same-family fidelity", () => {
  it("F13: message name round-trips on the completions wire", () => {
    const req = OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", name: "alice", content: "hi" }] });
    const msgs = req.render(target()).messages as Array<Record<string, unknown>>;
    expect(msgs[0].name).toBe("alice");
  });

  it("F13: a refusal is surfaced as text, not dropped", () => {
    const res = OpenAICompletionResponse.parse({
      id: "c", model: "up", choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "I cannot do that." }, finish_reason: "stop" }],
    });
    expect(res.text()).toContain("I cannot do that.");
  });

  it("F14: input_audio replays verbatim to its own family and vanishes elsewhere", () => {
    const audio = { type: "input_audio", input_audio: { data: "QQ==", format: "wav" } };
    const req = OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hear" }, audio] }] });
    const same = req.render(target()).messages as Array<{ content: unknown }>;
    expect(JSON.stringify(same[0].content)).toContain("input_audio");
    const anth = AnthropicRequest.construct(req).render(target());
    expect(JSON.stringify(anth)).not.toContain("input_audio");
  });

  it("F15: cached/reasoning token details survive parse and re-render", () => {
    const res = OpenAICompletionResponse.parse({
      id: "c", model: "up",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 90 }, completion_tokens_details: { reasoning_tokens: 4 } },
    });
    expect(res.usage.cachedInputTokens).toBe(90);
    expect(res.usage.reasoningTokens).toBe(4);
    const rendered = res.renderSelf("svc") as { usage: Record<string, unknown> };
    expect((rendered.usage.prompt_tokens_details as { cached_tokens: number }).cached_tokens).toBe(90);
  });
});

describe("translate-not-drop: parallel tools and user id", () => {
  it("parallel_tool_calls=false becomes tool_choice.disable_parallel_tool_use", () => {
    const req = OpenAICompletionRequest.parse({
      model: "svc", parallel_tool_calls: false,
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
      messages: [{ role: "user", content: "q" }],
    });
    const tc = AnthropicRequest.construct(req).render(target()).tool_choice as Record<string, unknown>;
    expect(tc.disable_parallel_tool_use).toBe(true);
  });

  it("anthropic disable_parallel_tool_use and metadata.user_id cross to the OpenAI wire", () => {
    const req = AnthropicRequest.parse({
      model: "svc", max_tokens: 10,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      metadata: { user_id: "end-user-7" },
      tools: [{ name: "f", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "q" }],
    });
    const body = OpenAICompletionRequest.construct(req).render(target());
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.user).toBe("end-user-7");
  });
});

describe("auto cache breakpoint (OpenAI hint -> Anthropic flag)", () => {
  it("plants cache_control on the last cacheable block when the client hinted caching", () => {
    const req = OpenAICompletionRequest.parse({
      model: "svc", prompt_cache_key: "sess-1",
      messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }],
    });
    req.params.cacheTtlMinutes = 30;
    const msgs = AnthropicRequest.construct(req).render(target()).messages as Array<{ content: Array<Record<string, unknown>> }>;
    const lastBlocks = msgs[msgs.length - 1].content;
    expect(lastBlocks[lastBlocks.length - 1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Only the last message gets the flag.
    expect(JSON.stringify(msgs[0])).not.toContain("cache_control");
  });

  it("ttl <= 5 minutes renders as the wire's 5m default (no ttl field)", () => {
    const req = OpenAICompletionRequest.parse({ model: "svc", prompt_cache_key: "s", messages: [{ role: "user", content: "q" }] });
    req.params.cacheTtlMinutes = 5;
    const msgs = AnthropicRequest.construct(req).render(target()).messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("never overrides a client's own breakpoint, and no hint means no flag", () => {
    const own = AnthropicRequest.parse({
      model: "svc", max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] }],
    });
    own.params.cacheHint = true;
    own.params.cacheTtlMinutes = 30;
    const blocks = (own.render(target()).messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" }); // untouched, no ttl added
    const plain = OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content: "q" }] });
    expect(JSON.stringify(AnthropicRequest.construct(plain).render(target()))).not.toContain("cache_control");
  });
});
