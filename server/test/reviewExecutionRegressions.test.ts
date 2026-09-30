import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import "../src/core/format";
import { buildRequest, parseResponse, parseStream, serializeStream } from "../src/core/format/registry";
import { collectStream, fabricateStream } from "../src/core/ir/stream";
import { ZERO_USAGE } from "../src/core/ir/usage";
import { MicroAgent } from "../src/execution/microAgent";
import { parseService, type AgentDef } from "../src/execution/definition";
import type { Catalog } from "../src/catalog/catalog";
import { imageHash, type OcrCacheStore } from "../src/execution/ocrCache";
import type { ImagePart } from "../src/core/ir/content";
import { observeDelivery } from "../src/transport/delivery";
import { EventEmitter } from "node:events";

it("preserves content_filter and context exhaustion in buffered and streamed mapping", async () => {
  const response = parseResponse("anthropic", { content: [], stop_reason: "model_context_window_exceeded" });
  expect(response.stopReason).toBe("length");
  const filtered = parseResponse("anthropic", { content: [], stop_reason: "refusal" });
  expect(filtered.render("openai_responses", "m")).toMatchObject({ status: "incomplete", incomplete_details: { reason: "content_filter" } });
  const wire = serializeStream("openai_responses", fabricateStream(filtered.data(), Infinity), { model: "m" });
  expect((await collectStream(parseStream("openai_responses", wire))).data.stopReason).toBe("content_filter");
});
it.each(["anthropic", "openai_responses"] as const)("emits paused provider-executed calls on the %s wire", async family => {
  const data = { id: "r", model: "m", created: 0, content: [{ type: "tool_use" as const, serverTool: true, id: "c", name: "web_search", input: { query: "q" } }], stopReason: "pause_turn" as const, usage: ZERO_USAGE };
  const collected = await collectStream(parseStream(family, serializeStream(family, fabricateStream(data, Infinity), { model: "m" })));
  expect(collected.incomplete).toBe(false); expect(collected.data.stopReason).toBe("pause_turn");
  expect(collected.data.content[0]).toMatchObject({ id: "c" });
});

describe("OCR original-input routing and cache ordering", () => {
  it("tests original image presence after translation and touches hits before storing misses", async () => {
    const cachedImage: ImagePart = { type: "image", source: { kind: "base64", mediaType: "image/png", data: "YQ==" } };
    const freshImage: ImagePart = { type: "image", source: { kind: "base64", mediaType: "image/png", data: "Yg==" } };
    const request = buildRequest("openai_completion", { requestedService: "agent", messages: [{ role: "user", content: [cachedImage, freshImage] }], params: {}, stream: false });
    const order: string[] = [];
    const cache: OcrCacheStore = { enabled: () => true, lookup: () => new Map([[imageHash(cachedImage), "cached"]]), touch: () => { order.push("touch"); }, store: () => { order.push("store"); } };
    let calls = 0;
    const transport = { postJson: async () => { calls++; const content = calls === 1 ? '["fresh"]' : calls === 2 ? "image-route" : "wrong-route";
      return { status: 200, headers: {}, text: "", json: { choices: [{ message: { content }, finish_reason: "stop" }] } }; }, postStream: async () => ({ status: 200, headers: {}, body: Readable.from([]) }) };
    const catalog = { resolve: () => ({ ok: true, target: { family: "openai_completion", upstreamModel: "m", modelName: "m", providerName: "p", url: "https://test.invalid", headers: {}, upstream: {} } }) } as unknown as Catalog;
    const def = parseService({ kind: "micro_agent", timeoutMs: 1000, ocr: { steps: [{ model: "m", provider: "p" }] }, stages: [
      { name: "route", type: "router", input: [], transitions: [{ when: { type: "input_has_image" }, goto: "image" }] },
      { name: "wrong", input: [], steps: [{ model: "m", provider: "p" }], transitions: [{ when: { type: "always" }, goto: "end" }] },
      { name: "image", input: [], steps: [{ model: "m", provider: "p" }] },
    ] }) as AgentDef;
    const agent = new MicroAgent(def, { catalog, transport, logMaxChars: 1000, resolver: { resolve: () => ({ ok: false, message: "unused" }) }, ocrCache: cache } as never);
    const result = await agent.invoke(request);
    expect(result.result.ok).toBe(true);
    if (result.result.ok) expect(result.result.value.response.text()).toBe("image-route");
    expect(order.indexOf("touch")).toBeLessThan(order.indexOf("store"));
  });
});

it("delivery observer never records an undelivered success", () => {
  const raw = new EventEmitter() as EventEmitter & { writableFinished: boolean; socket: null };
  raw.writableFinished = false; raw.socket = null;
  const record = vi.fn(), amend = vi.fn();
  observeDelivery({ raw } as never, record, amend);
  expect(record).not.toHaveBeenCalled(); raw.emit("close");
  expect(record).toHaveBeenCalledWith(true, expect.stringContaining("closed")); raw.emit("finish");
  expect(record).toHaveBeenCalledTimes(1);
});
