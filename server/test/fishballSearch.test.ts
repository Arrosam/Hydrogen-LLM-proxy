import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { callFishballSearch, normalizeSearch, searchParameters, trust } from "../src/execution/fishballSearch";
import { HttpToolSchema } from "../src/execution/toolHttp";
const tool = HttpToolSchema.parse({ name: "search", parameters: searchParameters, url: "https://search.test/search", headers: { "X-FishBall-Token": "server-secret" }, bodyTemplate: {}, adapter: { kind: "fishball_search_v1" }, timeoutMs: 100 });
const hit = (url = "https://who.int/article") => ({ url, title: "标题", content: "原文", engine: "google" });
const response = (body: unknown, status = 200) => ({ status, headers: {}, body: Readable.from([JSON.stringify(body)]) });
const postStream = vi.fn();
describe("Fishball search adapter", () => {
  it("preserves multilingual queries and all search controls without exposing credentials", async () => {
    const getStream = vi.fn(async () => response({ results: [hit()] }));
    const result = await callFishballSearch(tool, { queries: ["药物 café"], language: "zh-CN", categories: "science", time_range: "month", page: 2 }, [], { getStream, postStream });
    const [url, headers] = getStream.mock.calls[0] as unknown as [string, Record<string, string>];
    const params = new URL(url).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ q: "药物 café", language: "zh-CN", categories: "science", time_range: "month", pageno: "2", format: "json", safesearch: "1" });
    expect(headers["X-FishBall-Token"]).toBe("server-secret");
    expect(result.output).not.toContain("server-secret");
    expect(JSON.parse(result.output)).toMatchObject({ status: "success", hits: [{ tier: "AUTHORITATIVE" }] });
  });
  it("distinguishes empty from degraded and malformed responses", () => {
    expect(normalizeSearch("q", { results: [] }).status).toBe("empty");
    expect(normalizeSearch("q", { results: [], unresponsive_engines: [["bing", "timeout"]] })).toMatchObject({ status: "degraded", engines: ["bing"] });
    expect(normalizeSearch("q", { results: [hit(), { url: "javascript:bad" }] }).status).toBe("degraded");
    expect(() => normalizeSearch("q", {})).toThrow();
    expect(() => normalizeSearch("q", { results: [{ url: "bad" }] })).toThrow();
  });
  it.each([401, 403, 400])("does not retry authorization or permanent HTTP %s failures", async status => {
    const getStream = vi.fn(async () => response({}, status));
    const result = await callFishballSearch(tool, { queries: ["q"] }, [], { getStream, postStream });
    expect(result.isError).toBe(true); expect(JSON.parse(result.output).status).toBe("failed"); expect(getStream).toHaveBeenCalledTimes(1);
  });
  it("retries a transient failure once and keeps a failed query distinct in a partial batch", async () => {
    const getStream = vi.fn(async (url: string) => response(new URL(url).searchParams.get("q") === "good" ? { results: [hit()] } : {}, new URL(url).searchParams.get("q") === "good" ? 200 : 503));
    const result = await callFishballSearch({ ...tool, timeoutMs: 1000 }, { queries: ["bad", "good"] }, [], { getStream, postStream });
    expect(JSON.parse(result.output)).toMatchObject({ status: "degraded", queries: [{ status: "failed" }, { status: "success" }] }); expect(getStream).toHaveBeenCalledTimes(3);
  });
  it("bounds stalled responses and propagates cancellation instead of returning empty", async () => {
    const getStream = vi.fn(async (_url, _headers, opts) => {
      await new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true }));
      return response({});
    });
    const timer = setTimeout(() => {}, 1000);
    try {
      const result = await callFishballSearch(tool, { queries: ["q"] }, [], { getStream, postStream });
      expect(JSON.parse(result.output).queries[0].error).toBe("timeout");
      const abort = new AbortController();
      const pending = callFishballSearch(tool, { queries: ["q"] }, [], { getStream, postStream }, abort.signal); abort.abort();
      await expect(pending).rejects.toThrow();
    } finally { clearTimeout(timer); }
  });
  it("rejects malformed JSON and excessive bodies without retry", async () => {
    for (const body of ["not-json", "x".repeat(200)]) {
      const getStream = vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from([body]) }));
      const result = await callFishballSearch({ ...tool, maxResultBytes: 100 }, { queries: ["q"] }, [], { getStream, postStream });
      expect(result.isError).toBe(true); expect(getStream).toHaveBeenCalledTimes(1);
    }
  });
  it("reranks on the server, preserves omitted hits, and falls back to engine order", async () => {
    const ranker = HttpToolSchema.parse({ name: "rank", parameters: { type: "object" }, url: "https://rank.test", bodyTemplate: { query: "{{arguments.query}}", documents: "{{arguments.documents}}" } });
    const getStream = vi.fn(async () => response({ results: [hit("https://a.test"), hit("https://b.test")] }));
    const postStream = vi.fn(async () => response([{ index: 1, relevance_score: 0.8 }]));
    const ranked = await callFishballSearch({ ...tool, adapter: { kind: "fishball_search_v1", rerankTool: "rank" } }, { queries: ["q"] }, [ranker], { getStream, postStream });
    expect(JSON.parse(ranked.output).hits.map((h: { url: string }) => h.url)).toEqual(["https://b.test", "https://a.test"]);
    postStream.mockImplementation(async () => response({}, 503));
    const fallback = await callFishballSearch({ ...tool, adapter: { kind: "fishball_search_v1", rerankTool: "rank" } }, { queries: ["q"] }, [ranker], { getStream, postStream });
    expect(JSON.parse(fallback.output).hits[0].url).toBe("https://a.test");
    expect(JSON.parse(fallback.output).queries[0].ranking).toBe("engine");
  });
  it("uses conservative publisher-first trust", () => {
    expect(trust({ url: "https://who.int/article", title: "", snippet: "", engine: "" }).tier).toBe("AUTHORITATIVE");
    expect(trust({ url: "https://who.int.evil.test", title: "", snippet: "", engine: "" }).tier).toBe("LOW");
    expect(trust({ url: "https://weibo.com/post", title: "", snippet: "", engine: "", account: "looks like WHO" }).tier).toBe("LOW");
  });
});
