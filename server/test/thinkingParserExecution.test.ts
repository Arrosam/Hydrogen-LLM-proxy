import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { ModelService } from "../src/execution/modelService";
import { parseService, type ServiceSteps } from "../src/execution/definition";
import { OpenAICompletionRequest } from "../src/core/format";
import { collectStream } from "../src/core/ir/stream";
import type { Catalog } from "../src/catalog/catalog";
import type { Transport } from "../src/core/upstream/transport";

const pair = { open: "<|channel|>analysis<|message|>", close: "<|channel|>final<|message|>" };
const request = () => OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content: "hello" }] });
const catalog = { resolve: (model: string, provider: string) => ({ ok: true,
  target: { family: "openai_completion", upstreamModel: model, url: `http://${provider}`, headers: {}, modelName: model, providerName: provider, upstream: {} } }) } as unknown as Catalog;

function transport(failPrimary: boolean, raw: string, stopReason = "stop"): Transport {
  const frames = (raw: string) => [
    `data: ${JSON.stringify({ id: "c", model: "up", choices: [{ delta: { role: "assistant" } }] })}\n\n`,
    ...Array.from(raw).map(text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: stopReason }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return {
    async postJson(url) {
      const failed = failPrimary && url.includes("primary");
      return { status: failed ? 503 : 200, headers: {}, text: "", json: failed ? { error: "unavailable" } : {
        id: "c", model: "up", choices: [{ message: { role: "assistant", content: raw }, finish_reason: stopReason }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      } };
    },
    async postStream(url) {
      const failed = failPrimary && url.includes("primary");
      return { status: failed ? 503 : 200, headers: {}, body: Readable.from(failed ? ['{"error":"unavailable"}'] : frames(raw)) };
    },
  };
}
const def = (): ServiceSteps => ({ timeoutMs: 1000, thinkingFormat: "none", steps: [
  { model: "harmony", provider: "primary", retry: { maxAttempts: 1 }, thinkingParser: { mode: "custom", delimiters: pair } },
  { model: "r1", provider: "fallback", thinkingParser: { mode: "think_tags" } },
] } as ServiceSteps);

describe("upstream-specific decoding before canonical history", () => {
  for (const fallback of [false, true]) for (const streaming of [false, true]) {
    it(`uses the winning step grammar (fallback=${fallback}, stream=${streaming})`, async () => {
      const raw = fallback ? "<think>private</think>answer" : `${pair.open}private${pair.close}answer`;
      const service = new ModelService(def(), { catalog, transport: transport(fallback, raw) });
      if (streaming) {
        const result = await service.stream(request().withStream(true));
        expect(result.result.ok).toBe(true);
        if (!result.result.ok) throw Error("unexpected invocation failure");
        const { data } = await collectStream(result.result.value.events);
        expect(data.content).toEqual([{ type: "reasoning", text: "private" }, { type: "text", text: "answer" }]);
      } else {
        const result = await service.invoke(request());
        expect(result.result.ok).toBe(true);
        if (!result.result.ok) throw Error("unexpected invocation failure");
        expect(result.result.value.response.content).toEqual([{ type: "reasoning", text: "private" }, { type: "text", text: "answer" }]);
        expect(result.result.value.response.withThinkingFormat("none").text()).toBe("answer");
      }
    });
  }

  for (const interruption of ["tool", "native"] as const) for (const reliableStreaming of [false, true]) {
    it(`decodes before collection can reorder an ${interruption} interruption (reliable=${reliableStreaming})`, async () => {
      const upstream = transport(false, "unused");
      const deltas = [{ content: "<think>PRIVATE_LEAK" }, interruption === "native" ? { reasoning_content: "native" }
        : { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { content: "</think>answer" }];
      upstream.postStream = async () => ({ status: 200, headers: {}, body: Readable.from([
        ...deltas.map(delta => `data: ${JSON.stringify({ id: "c", model: "up", choices: [{ delta }] })}\n\n`),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`,
        "data: [DONE]\n\n",
      ]) });
      const service = new ModelService({ timeoutMs: 1000, reliableStreaming, thinkingFormat: "none",
        steps: [{ model: "m", provider: "p", thinkingParser: { mode: "think_tags" }, retry: { maxAttempts: 1 } }] } as ServiceSteps,
      { catalog, transport: upstream });
      const result = await service.stream(request().withStream(true));
      if (reliableStreaming) {
        expect(result.result.ok).toBe(false);
        if (!result.result.ok) expect(result.result.message).toContain("thinking block was interrupted");
      } else {
        if (!result.result.ok) throw Error("unexpected pre-stream failure");
        const collected = await collectStream(result.result.value.events);
        expect(collected.error).toContain("thinking block was interrupted");
        expect(collected.data.content.some(part => part.type === "tool_use")).toBe(false);
        expect(collected.data.content.filter(part => part.type === "text")).toEqual([]);
      }
    });
  }

  for (const mode of ["json", "buffered-sse", "relay", "reliable"] as const) {
    it(`rejects ambiguous quoted boundaries on an output token limit (${mode})`, async () => {
      const upstream = transport(false, "<think>example `</think>PRIVATE_TAIL", "length");
      const service = new ModelService({ timeoutMs: 1000, reliableStreaming: mode === "reliable", thinkingFormat: "none",
        steps: [{ model: "m", provider: "p", thinkingParser: { mode: "think_tags" }, retry: { maxAttempts: 1 } }] } as ServiceSteps,
      { catalog, transport: upstream });
      if (mode === "json" || mode === "buffered-sse") {
        const result = await service.invoke(request().withStream(mode === "buffered-sse"));
        expect(result.result.ok).toBe(false);
        if (result.result.ok) throw Error("expected decode failure");
        expect(result.result.message).toContain("thinking block was interrupted");
        expect(result.result.usage?.totalTokens).toBe(5);
        expect(JSON.stringify(result)).not.toContain("PRIVATE_TAIL");
      } else {
        const result = await service.stream(request().withStream(true));
        if (mode === "reliable") {
          expect(result.result.ok).toBe(false);
          if (result.result.ok) throw Error("expected reliable decode failure");
          expect(result.result.message).toContain("thinking block was interrupted");
        } else {
          if (!result.result.ok) throw Error("unexpected pre-stream failure");
          const collected = await collectStream(result.result.value.events);
          expect(collected.error).toContain("thinking block was interrupted");
          expect(collected.data.content.filter(part => part.type === "text")).toEqual([]);
          expect(collected.data.usage.totalTokens).toBe(5);
        }
      }
    });
  }

  it("does not implicitly scan when only an output format is configured", async () => {
    const service = new ModelService({ timeoutMs: 1000, thinkingFormat: "none", steps: [{ model: "m", provider: "p" }] },
      { catalog, transport: transport(false, "<reason>legitimate answer</reason>") });
    const result = await service.invoke(request());
    if (!result.result.ok) throw Error("unexpected invocation failure");
    expect(result.result.value.response.withThinkingFormat("none").text()).toBe("<reason>legitimate answer</reason>");
  });

  it("omits raw token logprobs only when inline decoding is enabled", async () => {
    const upstream = transport(false, "<think>private</think>answer");
    const originalPost = upstream.postJson;
    upstream.postJson = async (...args) => {
      const reply = await originalPost(...args);
      const json = reply.json as { choices: Array<Record<string, unknown>> };
      json.choices[0].logprobs = { content: [{ token: "private", logprob: -1 }] };
      return reply;
    };
    for (const enabled of [true, false]) {
      const service = new ModelService({ timeoutMs: 1000, steps: [{ model: "m", provider: "p", ...(enabled ? { thinkingParser: { mode: "think_tags" as const } } : {}) }] }, { catalog, transport: upstream });
      const result = await service.invoke(request());
      if (!result.result.ok) throw Error("unexpected invocation failure");
      if (enabled) expect(result.result.value.response.logprobs).toBeUndefined();
      else expect(result.result.value.response.logprobs).toBeDefined();
    }
  });

  it("retains failed decode usage and lets a different upstream try its own grammar", async () => {
    const definition = def();
    definition.steps[0].thinkingParser = { mode: "think_tags" };
    definition.steps[1].thinkingParser = { mode: "off" };
    const service = new ModelService(definition, { catalog, transport: transport(false, "<think>unfinished") });
    const result = await service.invoke(request());
    expect(result.attempts).toBe(2);
    if (!result.result.ok) throw Error("unexpected invocation failure");
    expect(result.result.value.response.usage.totalTokens).toBe(10);
    expect(result.result.value.modelName).toBe("r1");
  });
});

describe("thinking parser definition validation", () => {
  const parse = (parser: unknown) => parseService({ steps: [{ model: "m", provider: "p", thinkingParser: parser }] });
  it("preserves an explicit step parser independently of presentation", () => {
    expect(parse({ mode: "custom", delimiters: pair, unterminated: "reasoning" })).toMatchObject({ steps: [{ thinkingParser: { mode: "custom", delimiters: pair, unterminated: "reasoning" } }] });
  });
  it.each([
    { mode: "custom" }, { mode: "custom", delimiters: { open: "", close: "x" } },
    { mode: "custom", delimiters: { open: "x", close: "x" } },
    { mode: "custom", delimiters: { open: " ", close: "x" } },
    { mode: "think_tags", unterminated: "text" }, { mode: "off", delimiters: pair },
  ])("rejects unsafe or ambiguous settings: %j", parser => expect(() => parse(parser)).toThrow());
  it("rejects legacy service-wide delimiters with migration guidance", () => {
    expect(() => parseService({ steps: [{ model: "m", provider: "p" }], thinkingDelimiters: pair })).toThrow(/Move thinkingDelimiters/);
    expect(() => parseService({ kind: "micro_agent", stages: [], thinkingDelimiters: pair })).toThrow(/Move thinkingDelimiters/);
  });
});
