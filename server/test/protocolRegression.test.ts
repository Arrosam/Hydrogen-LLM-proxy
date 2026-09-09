import { describe, expect, it } from "vitest";
import { AnthropicRequest, AnthropicResponse, OpenAICompletionRequest, OpenAIResponsesRequest, parseStream, serializeStream } from "../src/core/format";
import { collectStream, fabricateStream, newAccumulator, parseSSE, tapStream, type StreamEvent } from "../src/core/ir/stream";
import type { Family } from "../src/core/ir/params";
import type { Transport } from "../src/core/upstream/transport";

async function* source<T>(values: T[]): AsyncGenerator<T> { yield* values; }
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
async function drain<T>(events: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const e of events) out.push(e); return out; }
const target = { upstreamModel: "m" };
const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedInputTokens: 80, reasoningTokens: 12 };
const nativeUsage = { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 20, output_tokens_details: { thinking_tokens: 12 } };
const signedBlocks = [
  { type: "thinking", thinking: "first thought", signature: "sig-one" },
  { type: "redacted_thinking", data: "opaque" },
  { type: "thinking", thinking: "second thought", signature: "sig-two" },
  { type: "tool_use", id: "call_1", name: "lookup", input: {} },
];
const anthropicResponse = () => AnthropicResponse.parse({ id: "msg", model: "claude", content: signedBlocks, stop_reason: "tool_use", usage: nativeUsage });

describe("usage accounting regressions", () => {
  it.each([{}, { completion_tokens: 25, total_tokens: 125 }])("merges supplied Chat counters without erasing earlier details: %j", async later => {
    const events = parseStream("openai_completion", source([
      frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 12 } } }),
      frame({ choices: [], usage: later }), "data: [DONE]\n\n",
    ]));
    const result = await collectStream(events);
    expect(result.data.usage).toEqual({ ...usage, ...(later.completion_tokens != null ? { completionTokens: 25, totalTokens: 125 } : {}) });
  });

  it("honors explicit zero counters", async () => {
    const result = await collectStream(parseStream("openai_completion", source([
      frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 12 } } }),
      frame({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } }),
      "data: [DONE]\n\n",
    ])));
    expect(result.data.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });
  });

  it("reads Anthropic thinking details and carries them through every client format", async () => {
    const response = anthropicResponse();
    expect(response.usage).toEqual(usage);
    for (const family of ["anthropic", "openai_completion", "openai_responses"] as Family[]) {
      const wire = await drain(serializeStream(family, fabricateStream(response.data(), Infinity), { model: "svc" }));
      const roundtrip = await collectStream(parseStream(family, source(wire)));
      expect(roundtrip.data.usage).toEqual(usage);
    }
  });

  it("retains initial cache usage when a read throws", async () => {
    async function* broken() {
      yield frame({ type: "message_start", message: { id: "m", usage: { input_tokens: 20, cache_read_input_tokens: 80 } } });
      throw Error("socket closed");
    }
    const acc = newAccumulator();
    await expect(drain(tapStream(parseStream("anthropic", broken()), acc))).rejects.toThrow("socket closed");
    expect(acc.usage).toMatchObject({ promptTokens: 100, cachedInputTokens: 80, incomplete: true });
  });

  it.each(["anthropic", "openai_completion"] as Family[])("retains the last usage snapshot before a read throws: %s", async family => {
    async function* broken() {
      if (family === "anthropic") {
        yield frame({ type: "message_start", message: { id: "m", usage: { input_tokens: 20, cache_read_input_tokens: 80 } } });
        yield frame({ type: "message_delta", usage: nativeUsage });
      } else yield frame({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 12 } } });
      throw Error("socket closed");
    }
    const acc = newAccumulator();
    await expect(drain(tapStream(parseStream(family, broken()), acc))).rejects.toThrow();
    expect(acc.usage).toEqual({ ...usage, incomplete: true });
  });
});

describe("request fidelity regressions", () => {
  it.each(["claude-sonnet-4-5-20250929", "claude-haiku-4-5", "claude-opus-4-6", "vendor-model"])("preserves native manual thinking and display on %s", upstreamModel => {
    const thinking = { type: "enabled", budget_tokens: 2048, display: "omitted" };
    const out = AnthropicRequest.parse({ messages: [], thinking, max_tokens: 4096 }).render({ upstreamModel });
    expect(out.thinking).toEqual(thinking);
    expect(out.max_tokens).toBe(4096);
    expect(out.output_config).toBeUndefined();
  });
  it("keeps disabled separate from effort and lets overrides replace native mode", () => {
    const req = AnthropicRequest.parse({ messages: [], thinking: { type: "disabled" }, output_config: { effort: "low" } });
    expect(req.params.thinking).toBe("disabled");
    expect(req.render(target)).toMatchObject({ thinking: { type: "disabled" }, output_config: { effort: "low" } });
    expect(req.withOverrides({ thinking: "high" }).render(target)).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  });
  it.each(["claude-sonnet-4-5", "claude-opus-4-6", "claude-sonnet-4-6"])("selects the correct cross-family mode for %s", upstreamModel => {
    const out = AnthropicRequest.construct(OpenAICompletionRequest.parse({ messages: [], reasoning_effort: "low", max_tokens: 4096 })).render({ upstreamModel });
    expect(out.thinking).toEqual(upstreamModel.includes("4-5") ? { type: "enabled", budget_tokens: 2048 } : { type: "adaptive" });
  });
  it("retains the Chat ceiling key and uses the supported key for o-series", () => {
    const modern = OpenAICompletionRequest.parse({ messages: [], max_completion_tokens: 100 });
    expect(modern.render(target)).toMatchObject({ max_completion_tokens: 100 });
    expect(modern.render(target)).not.toHaveProperty("max_tokens");
    const old = OpenAICompletionRequest.parse({ messages: [], max_tokens: 100 });
    expect(old.render(target)).toHaveProperty("max_tokens", 100);
    expect(old.render({ upstreamModel: "o3" })).toHaveProperty("max_completion_tokens", 100);
  });
  it("preserves nested Responses options while canonical overrides win", () => {
    const req = OpenAIResponsesRequest.parse({ input: [], reasoning: { effort: "high", summary: "auto" }, text: { verbosity: "low", format: { type: "json_object" }, vendor: true } });
    expect(req.withOverrides({ thinking: "low", verbosity: "high" }).render(target)).toMatchObject({ reasoning: { effort: "low", summary: "auto" }, text: { verbosity: "high", format: { type: "json_object" }, vendor: true } });
    expect(OpenAICompletionRequest.construct(req).render(target)).not.toHaveProperty("text");
  });
});

describe("signed reasoning replay", () => {
  it.each(["openai_completion", "openai_responses"] as Family[])("restores all Anthropic blocks after a buffered %s client roundtrip", family => {
    const response = anthropicResponse();
    const rendered: any = response.render(family, "svc");
    const req = family === "openai_completion"
      ? OpenAICompletionRequest.parse({ messages: [rendered.choices[0].message] })
      : OpenAIResponsesRequest.parse({ input: rendered.output });
    const out: any = AnthropicRequest.construct(req).render(target);
    expect(out.messages[0].content).toEqual(signedBlocks);
    const other = JSON.stringify(OpenAIResponsesRequest.construct(req).render(target));
    expect(other).not.toContain("sig-one");
    expect(other).not.toContain("hydrogen-");
  });
  it.each(["openai_completion", "openai_responses"] as Family[])("preserves streamed signed block boundaries through %s", async family => {
    const wire = await drain(serializeStream(family, fabricateStream(anthropicResponse().data(), Infinity), { model: "svc" }));
    const collected = await collectStream(parseStream(family, source(wire)));
    const req = new AnthropicRequest({ requestedService: "svc", messages: [{ role: "assistant", content: collected.data.content }], params: {}, stream: false });
    const out: any = req.render(target);
    expect(out.messages[0].content).toEqual(signedBlocks);
  });
  it("never sends Responses encrypted bytes as an Anthropic signature", () => {
    const req = OpenAIResponsesRequest.parse({ input: [{ type: "reasoning", id: "rs1", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "openai-opaque" }, { type: "function_call", call_id: "c", name: "f", arguments: "{}" }] });
    const out: any = AnthropicRequest.construct(req).render(target);
    expect(JSON.stringify(out)).not.toContain("openai-opaque");
    expect(out.messages[0].content[0]).toEqual({ type: "text", text: "thought" });
  });
});

it.each([true, false])("closes text before %s reasoning boundaries in Anthropic SSE", async explicit => {
  const events: StreamEvent[] = [
    { type: "start", id: "m", model: "m", created: 0 }, { type: "text_delta", text: "before" },
    ...(explicit ? [{ type: "reasoning_start" } as StreamEvent] : []),
    { type: "reasoning_delta", text: "thought" }, { type: "reasoning_stop", signature: "s" },
    { type: "text_delta", text: "after" }, { type: "finish", stopReason: "stop", usage },
  ];
  const wire = serializeStream("anthropic", source(events), { model: "svc" });
  const blocks: any[] = [];
  let active: number | null = null;
  for await (const f of parseSSE(wire)) {
    const d = JSON.parse(f.data);
    if (d.type === "content_block_start") { expect(active).toBeNull(); active = d.index; blocks.push(d.content_block.type); }
    if (d.type === "content_block_stop") { expect(d.index).toBe(active); active = null; }
  }
  expect(blocks).toEqual(["text", "thinking", "text"]);
});

it("treats HTTP 200 Responses failures as retryable failures", async () => {
  const body = { status: "failed", error: { code: "server_error", message: "generation failed" }, output: [] };
  const transport: Transport = {
    async postJson() { return { status: 200, headers: {}, text: JSON.stringify(body), json: body }; },
    async postStream() { throw Error("unexpected stream"); },
  };
  const result = await OpenAIResponsesRequest.parse({ input: [], stream: false }).send(transport, { ...target, url: "http://unused", headers: {}, timeoutMs: 1000 });
  expect(result).toMatchObject({ ok: false, status: 502, body, message: "generation failed" });
});
