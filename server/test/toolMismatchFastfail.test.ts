import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/core/format";
import { buildRequest, buildResponse, parseRequest, serializeStream } from "../src/core/format/registry";
import { collectStream, fabricateStream } from "../src/core/ir/stream";
import type { ContentPart } from "../src/core/ir/content";
import type { Family } from "../src/core/ir/params";
import type { Request, RenderTarget } from "../src/core/ir/request";
import type { Catalog } from "../src/catalog/catalog";
import type { Transport } from "../src/core/upstream/transport";
import { parseServiceSteps, type ServiceStep } from "../src/execution/definition";
import { ModelService } from "../src/execution/modelService";
import { HostedToolService } from "../src/execution/hostedToolService";
import { MicroAgent } from "../src/execution/microAgent";
import { HostedToolOptionsSchema, parseService, type AgentDef } from "../src/execution/definition";
import { runHostedTools } from "../src/execution/hostedToolLoop";
import { HttpToolSchema } from "../src/execution/toolHttp";
import { markLocalToolCall, prepareServerTools, ServerToolPreflightError, validateServerToolInput } from "../src/execution/serverTools";
import type { ToolUsePart } from "../src/core/ir/content";
import { runSteps, type AttemptFailure, type AttemptRecord } from "../src/execution/steps";
import { ProxyController } from "../src/transport/proxyController";
import type { ProxyDeps } from "../src/transport/deps";
import { ActiveRequestRegistry } from "../src/observability/activeRequests";
import type { LogParams } from "../src/observability/requestLogger";

const declared = { type: "web_search" };
const seed = (tools: unknown[] = [declared]) => parseRequest("openai_responses", { model: "svc", input: "hello", tools });
const retry = { maxAttempts: 100, on: ["error"], intervalMs: 600_000, backoff: { initialMs: 600_000, maxMs: 600_000 } };
const blocked = (provider: string) => ({ model: "m", provider, retry, advanceOn: [], serverToolPolicy: { mode: "whitelist", names: [] } });
const compatible = { model: "m", provider: "compatible", retry };
const tool = () => ({ ...HttpToolSchema.parse({ name: "lookup", url: "https://adapter.test/run", parameters: { type: "object" },
  bodyTemplate: {}, serverTool: { name: "web_search", resultPath: "/results" } }), id: 42 });

function retainedRequest(declarations: unknown[] = [declared, { type: "web_fetch" }], count = 1) {
  const entry = prepareServerTools(seed(), { tools: [tool()] }).matched.get("provider_server_side_lookup")!;
  const calls: ToolUsePart[] = Array.from({ length: count }, (_, i) => ({ type: "tool_use", id: `pending_${i + 1}`, name: entry.emittedName, input: {} }));
  for (const call of calls) markLocalToolCall(call, entry);
  const request = buildRequest(seed().family, { ...seed(declarations).data(), messages: [{ role: "assistant", content: calls }] });
  return { request, calls, entry };
}

/** Real formats/executors with separately counted provider, adapter and file IO.
 * Fake timers observe the absence of retry delay rather than replacing sleep. */
function fixture(steps: unknown[], opts: {
  families?: Record<string, Family>; reliableStreaming?: boolean;
  reply?: (provider: string, body: Record<string, unknown>, count: number) => number | ContentPart[] | Error;
} = {}) {
  const visited: string[] = [], requests: Array<{ provider: string; body: Record<string, unknown> }> = [], adapters: unknown[] = [], files: string[] = [];
  const catalog = { resolve: (_model: string, provider: string) => {
    visited.push(provider);
    return { ok: true, target: { family: opts.families?.[provider] ?? "openai_responses", url: `https://provider.test/${provider}`,
      headers: {}, upstream: {}, upstreamModel: "up", modelName: "m", providerName: provider } };
  } } as unknown as Catalog;
  const answer = (url: string, body: unknown) => {
    const provider = url.split("/").at(-1)!;
    const input = body as Record<string, unknown>;
    requests.push({ provider, body: structuredClone(input) });
    const reply = opts.reply?.(provider, input, requests.filter(entry => entry.provider === provider).length) ?? [{ type: "text", text: "done" }];
    if (reply instanceof Error) throw reply;
    const family = opts.families?.[provider] ?? "openai_responses";
    const response = typeof reply === "number" ? undefined : buildResponse(family, { id: "synthetic", model: "up", created: 1, content: reply,
      stopReason: reply.some(part => part.type === "tool_use") ? "tool_use" : "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    return { family, response, status: typeof reply === "number" ? reply : 200 };
  };
  const transport: Transport = {
    async postJson(url, _headers, body) {
      const result = answer(url, body);
      return { status: result.status, headers: {}, text: "", json: result.response?.renderSelf("up") ?? { error: { code: "tool_not_found", message: "Tool 'web_search' not found" } } };
    },
    async postStream(url, _headers, body) {
      if (url.startsWith("https://adapter.test/")) {
        adapters.push(body);
        return { status: 200, headers: {}, body: Readable.from(['{"results":[]}']) };
      }
      const result = answer(url, body);
      return { status: result.status, headers: {}, body: result.response
        ? Readable.from(serializeStream(result.family, fabricateStream(result.response.data(), Infinity), { model: "up" }))
        : Readable.from(['{"error":{"code":"tool_not_found","message":"Tool web_search not found"}}']) };
    },
    async getStream(url) {
      files.push(url);
      return { status: 200, headers: { "content-type": "application/pdf" }, body: Readable.from(["synthetic file"]) };
    },
  };
  const deps = { catalog, transport, simulatedStreamingTokenRate: Infinity };
  const service = new ModelService(parseServiceSteps({ timeoutMs: 1000, steps, reliableStreaming: opts.reliableStreaming }), deps);
  return { service, deps, visited, requests, adapters, files };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("HYD-TOOL-MISMATCH-FASTFAIL: equivalence, boundaries and sequential transitions", () => {
  it.each([1, 2, 100])("local policy mismatch skips %s configured attempts and backoff", async maxAttempts => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.99);
    const f = fixture([{ ...blocked("first"), retry: { ...retry, maxAttempts } }, compatible]);
    const before = Date.now();
    const inv = await f.service.invoke(seed());
    expect(inv.result.ok).toBe(true);
    expect(f.visited).toEqual(["first", "compatible"]);
    expect(f.requests.map(request => request.provider)).toEqual(["compatible"]);
    expect(f.adapters).toHaveLength(0); expect(f.files).toHaveLength(0);
    expect(Date.now()).toBe(before); expect(vi.getTimerCount()).toBe(0);
    expect(inv.attemptPath).toMatchObject([{ step: 1, attempt: 1, status: 400, retry: { delayMs: 0, suppressed: true, reason: expect.stringContaining("tool mismatch") } }, { step: 2, attempt: 1, kind: "ok" }]);
  });

  it("walks each mismatching stage in order, including disabled local availability", async () => {
    vi.useFakeTimers();
    const f = fixture([blocked("first"), blocked("middle"), compatible]);
    const inv = await f.service.invoke(seed(), undefined, { serverTools: { tools: [{ ...tool(), enabled: false }] } });
    expect(inv.result.ok).toBe(true); expect(f.visited).toEqual(["first", "middle", "compatible"]);
    expect((inv.attemptPath as AttemptRecord[]).map(entry => [entry.step, entry.attempt])).toEqual([[1, 1], [2, 1], [3, 1]]);
    expect(f.requests.map(request => request.provider)).toEqual(["compatible"]);
    expect(f.adapters).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("all mismatch returns the final native failure without any dispatch/delay", async () => {
    vi.useFakeTimers();
    const f = fixture([blocked("policy"), { ...compatible, provider: "wire" }], { families: { wire: "openai_completion" } });
    const inv = await f.service.invoke(seed());
    expect(inv.result).toMatchObject({ ok: false, status: 400, retryable: false,
      message: "Tool 'web_search' from openai_responses cannot be sent to openai_completion",
      errorBody: { error: { type: "invalid_request_error", code: null } } });
    expect(f.visited).toEqual(["policy", "wire"]); expect(inv.attempts).toBe(2);
    expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("stream and reliable stream advance without delay (reliable=%s)", async reliableStreaming => {
    vi.useFakeTimers();
    const f = fixture([blocked("first"), compatible], { reliableStreaming });
    const inv = await f.service.stream(seed().withStream(true));
    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) expect((await collectStream(inv.result.value.events)).data.content).toContainEqual({ type: "text", text: "done" });
    expect(f.requests.map(request => request.provider)).toEqual(["compatible"]);
    expect(f.adapters).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("native wire mismatch advances but an ordinary function is still compatible", async () => {
    vi.useFakeTimers();
    const f = fixture([{ ...compatible, provider: "wire" }, compatible], { families: { wire: "openai_completion" } });
    const raw = await f.service.invoke(seed());
    expect(raw.result.ok).toBe(true); expect(f.requests.map(request => request.provider)).toEqual(["compatible"]);
    f.requests.length = 0; f.visited.length = 0;
    const ordinary = await f.service.invoke(seed([{ type: "function", name: "web_search", parameters: { type: "object" } }]));
    expect(ordinary.result.ok).toBe(true); expect(f.visited).toEqual(["wire"]); expect(f.requests[0].provider).toBe("wire");
  });

  it("a valid native choice's wire incompatibility can fail over independently of its function", async () => {
    vi.useFakeTimers();
    const f = fixture([{ ...compatible, provider: "wire" }, compatible], { families: { wire: "openai_completion" } });
    const request = buildRequest(seed().family, { ...seed([{ type: "function", name: "client", parameters: {} }]).data(),
      toolChoice: { type: "raw", family: "openai_responses", value: { type: "function", name: "client" } } });
    const inv = await f.service.invoke(request);
    expect(inv.result.ok).toBe(true); expect(f.visited).toEqual(["wire", "compatible"]);
    expect(f.requests.map(entry => entry.provider)).toEqual(["compatible"]); expect(vi.getTimerCount()).toBe(0);
  });

  it("all-policy mismatch retains the Anthropic envelope and the last tool name", async () => {
    vi.useFakeTimers();
    const f = fixture([blocked("first"), { ...blocked("last"), overrides: { extra: { tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] } } }], { families: { first: "anthropic", last: "anthropic" } });
    const request = parseRequest("anthropic", { model: "svc", messages: [{ role: "user", content: "hello" }], tools: [{ type: "web_search_20250305", name: "web_search" }] });
    const inv = await f.service.invoke(request);
    expect(inv.result).toMatchObject({ ok: false, status: 400, errorBody: { type: "error", error: { type: "invalid_request_error", message: "Tool 'web_fetch' not found" } } });
    if (!inv.result.ok) expect((inv.result.errorBody as { error: unknown }).error).not.toHaveProperty("code");
    expect(f.visited).toEqual(["first", "last"]); expect(f.requests).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not fetch a URL attachment for a mismatching stage", async () => {
    vi.useFakeTimers();
    const f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_search"] } }, compatible], { families: { first: "openai_completion" } });
    const request = buildRequest(seed().family, { ...seed().data(), messages: [{ role: "user", content: [{ type: "file", source: { kind: "url", url: "https://files.test/doc.pdf" } }] }] });
    const inv = await f.service.invoke(request);
    expect(inv.result.ok).toBe(true); expect(f.files).toHaveLength(0); expect(f.requests.map(entry => entry.provider)).toEqual(["compatible"]);
  });

  it("cancellation stops before the next stage", async () => {
    const abort = new AbortController();
    const mismatch = prepareFailure();
    const attempt = vi.fn(async (_step: ServiceStep, index: number) => { if (index === 0) abort.abort(); return mismatch; });
    const out = await runSteps(parseServiceSteps({ steps: [blocked("first"), compatible] }), attempt, { signal: abort.signal });
    expect(attempt).toHaveBeenCalledTimes(1); expect(out.path).toHaveLength(1); expect(out.result).toEqual(mismatch);
  });
});

function prepareFailure(): AttemptFailure {
  try { prepareServerTools(seed(), { tools: [] }, { mode: "whitelist", names: [] }); }
  catch (error) { if (error instanceof ServerToolPreflightError) return error.failure(true); throw error; }
  throw new Error("expected mismatch");
}

describe("negative partitions: malformed/global inputs and upstream lookalikes", () => {
  it.each([
    { name: "duplicate raw declarations", request: () => seed([declared, declared]), code: "hydrogen_tool_name_conflict" },
    { name: "duplicate functions hidden by an earlier blocked tool", request: () => seed([declared, { type: "function", name: "f", parameters: {} }, { type: "function", name: "f", parameters: {} }]), code: "hydrogen_tool_name_conflict" },
    { name: "missing native choice", request: () => seed().withOverrides({ extra: { tool_choice: { type: "web_fetch" } } }), code: "tool_not_found" },
    { name: "missing function choice", request: () => seed().withOverrides({ extra: { tool_choice: { type: "function", name: "absent" } } }), code: "tool_not_found" },
    { name: "malformed tools overlay", request: () => seed().withOverrides({ extra: { tools: "invalid" } }), code: null },
    { name: "malformed tool choice overlay", request: () => seed().withOverrides({ extra: { tool_choice: 42 } }), code: null },
  ])("$name stays terminal before a permissive fallback", async ({ request, code }) => {
    vi.useFakeTimers();
    const f = fixture([blocked("first"), compatible]);
    const inv = await f.service.invoke(request());
    expect(inv.result).toMatchObject({ ok: false, status: 400, terminal: true, errorBody: { error: { code } } });
    expect(f.visited).toEqual(["first"]); expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    expect(() => f.service.prepareTools(request())).toThrow(ServerToolPreflightError);
  });

  it("duplicate binding aliases remain global before resolving any stage", async () => {
    const f = fixture([blocked("first"), compatible]);
    const inv = await f.service.invoke(seed(), undefined, { serverTools: { tools: [tool(), { ...tool(), id: 43, name: "second" }] } });
    expect(inv.result).toMatchObject({ ok: false, terminal: true, errorBody: { error: { code: "hydrogen_tool_name_conflict" } } });
    expect(f.visited).toHaveLength(0); expect(f.requests).toHaveLength(0);
  });

  it.each(["duplicate", "missing choice"])("first-step overlays cannot erase caller %s errors", async kind => {
    const f = fixture([{ ...blocked("first"), overrides: { extra: { tools: [], tool_choice: "none" } } }, compatible]);
    const request = kind === "duplicate" ? seed([declared, declared]) : parseRequest("openai_responses", {
      model: "svc", input: "hello", tools: [declared], tool_choice: { type: "function", name: "absent" },
    });
    const inv = await f.service.invoke(request);
    expect(inv.result).toMatchObject({ ok: false, terminal: true, status: 400 });
    expect(f.requests).toHaveLength(0); expect(f.visited).toEqual(["first"]);
    expect(() => f.service.prepareTools(request)).toThrow(ServerToolPreflightError);
  });

  it.each(["duplicate", "missing choice"])("agent tools:none cannot erase caller %s errors", async kind => {
    const f = fixture([compatible]);
    const agent = new MicroAgent(parseService({ kind: "micro_agent", stages: [{ name: "model", service: "model", tools: "none" }] }) as AgentDef,
      { ...f.deps, logMaxChars: 1000, resolver: { resolve: () => ({ ok: true, executor: f.service, isAgent: false }), sttDef: () => ({ ok: false, message: "unused" }) } });
    const request = kind === "duplicate" ? seed([declared, declared]) : seed().withOverrides({ extra: { tool_choice: { type: "function", name: "absent" } } });
    const inv = await agent.invoke(request);
    expect(inv.result).toMatchObject({ ok: false, terminal: true, status: 400 }); expect(f.requests).toHaveLength(0);
  });

  it("a validated native/client same-name pair stays valid in a later tools:none child", async () => {
    const f = fixture([compatible]);
    const first = new HostedToolService(f.service, f.deps, [tool()]);
    const second = new ModelService(parseServiceSteps({ steps: [{ ...compatible, provider: "second" }] }), f.deps);
    const agent = new MicroAgent(parseService({ kind: "micro_agent", stages: [{ name: "first", service: "first" }, { name: "second", service: "second", tools: "none" }] }) as AgentDef,
      { ...f.deps, logMaxChars: 1000, resolver: { resolve: name => ({ ok: true, executor: name === "first" ? first : second, isAgent: false }), sttDef: () => ({ ok: false, message: "unused" }) } });
    const inv = await agent.invoke(seed([declared, { type: "function", name: "web_search", parameters: {} }]));
    expect(inv.result.ok).toBe(true); expect(f.requests.map(entry => entry.provider)).toEqual(["compatible", "second"]);
    expect(f.requests[0].body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "web_search" }), expect.objectContaining({ name: "provider_server_side_lookup" })]));
    expect(f.requests[1].body.tools ?? []).toEqual([]); expect(f.adapters).toHaveLength(0);
  });

  it.each(["missing mapping", "router only"])("%s cannot hide caller duplicates before an OCR prepass", async kind => {
    const f = fixture([{ ...compatible, provider: "prepass" }]);
    const missing = new ModelService(parseServiceSteps({ steps: [compatible] }), { ...f.deps, catalog: { resolve: () => ({ ok: false, error: "missing mapping" }) } as unknown as Catalog });
    const agent = new MicroAgent(parseService({ kind: "micro_agent", ocr: { service: "prepass" }, stages: kind === "router only" ? [{ name: "router" }] : [{ name: "model", service: "missing", tools: "none" }] }) as AgentDef,
      { ...f.deps, logMaxChars: 1000, resolver: { resolve: name => ({ ok: true, executor: name === "prepass" ? f.service : missing, isAgent: false }), sttDef: () => ({ ok: false, message: "unused" }) } });
    const request = buildRequest(seed().family, { ...seed([declared, declared]).data(), messages: [{ role: "user", content: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA==" } }] }] });
    const inv = await agent.invoke(request);
    expect(inv.result).toMatchObject({ ok: false, terminal: true, status: 400, errorBody: { error: { code: "hydrogen_tool_name_conflict" } } });
    expect(f.requests).toHaveLength(0); expect(f.files).toHaveLength(0); expect(f.adapters).toHaveLength(0);
  });

  it("emitted collisions cannot be hidden behind a different unavailable declaration", async () => {
    const f = fixture([blocked("first"), compatible]);
    const inv = await f.service.invoke(seed([{ type: "web_fetch" }, declared, { type: "function", name: "provider_server_side_lookup", parameters: {} }]), undefined, { serverTools: { tools: [tool()] } });
    expect(inv.result).toMatchObject({ ok: false, terminal: true, errorBody: { error: { code: "hydrogen_tool_name_conflict" } } });
    expect(f.visited).toEqual(["first"]); expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0);
  });

  it.each(["native whitelist", "drop tools"])("a potential local emitted name remains valid when %s prevents its emission", async mode => {
    const step = mode === "native whitelist" ? { ...compatible, serverToolPolicy: { mode: "whitelist", names: ["web_search"] } }
      : { ...compatible, overrides: { extra: { tools: [], tool_choice: "none" } } };
    const f = fixture([step]);
    const request = seed([declared, { type: "function", name: "provider_server_side_lookup", parameters: {} }]);
    const inv = await f.service.invoke(request, undefined, { serverTools: { tools: [tool()] } });
    expect(inv.result.ok).toBe(true); expect(f.requests.map(entry => entry.provider)).toEqual(["compatible"]);
    expect(f.requests[0].body.tools ?? []).toEqual(mode === "native whitelist"
      ? [declared, expect.objectContaining({ type: "function", name: "provider_server_side_lookup" })] : []);
    expect(f.adapters).toHaveLength(0);
  });

  it("invalid emitted names stay terminal rather than becoming a wire mismatch", async () => {
    const f = fixture([blocked("first"), compatible]);
    const inv = await f.service.invoke(seed(), undefined, { serverTools: { tools: [{ ...tool(), name: "invalid name" }] } });
    expect(inv.result).toMatchObject({ ok: false, terminal: true, message: expect.stringContaining("Function name") });
    expect(f.visited).toEqual(["first"]); expect(f.requests).toHaveLength(0);
  });

  it.each(["openai_completion", "openai_responses", "anthropic"] as const)("raw %s validation rejects entries the IR parser would silently drop", family => {
    expect(() => validateServerToolInput({ tools: [{}, { type: "web_fetch" }] }, family)).toThrow(ServerToolPreflightError);
    expect(() => validateServerToolInput({ tools: [{ type: "function", name: 42, function: { name: 42 } }] }, family)).toThrow(ServerToolPreflightError);
    expect(() => validateServerToolInput({ tool_choice: { type: family === "anthropic" ? "tool" : "function" } }, family)).toThrow(ServerToolPreflightError);
    const malformed = family === "anthropic" ? { name: "f", input_schema: 42 } : family === "openai_completion" ? { type: "function", function: { name: "f", parameters: 42 } } : { type: "function", name: "f", parameters: 42 };
    expect(() => validateServerToolInput({ tools: [malformed] }, family)).toThrow(ServerToolPreflightError);
  });

  it("nested custom and allowed-tools names must be strings before IR coercion", () => {
    expect(() => validateServerToolInput({ tools: [{ type: "custom", custom: { name: 42 } }] }, "openai_completion")).toThrow(ServerToolPreflightError);
    expect(() => validateServerToolInput({ tool_choice: { type: "allowed_tools", tools: [{ type: "function", name: 42 }] } }, "openai_responses")).toThrow(ServerToolPreflightError);
  });

  it("opaque native/custom options are preserved outside ordinary schema slots", () => {
    expect(() => validateServerToolInput({ tools: [{ type: "vendor_native", parameters: 42 }, { type: "custom", name: "f", parameters: 42 }] }, "openai_responses")).not.toThrow();
  });

  it.each([400, 503])("upstream %s with identical tool error text/code retains retries and delay", async status => {
    vi.useFakeTimers();
    const f = fixture([{ ...compatible, retry: { maxAttempts: 3, on: ["error"], intervalMs: 250 } }, { ...compatible, provider: "fallback" }], { reply: (provider, _body, count) => provider === "compatible" && count < 3 ? status : [{ type: "text", text: "done" }] });
    const before = Date.now();
    const pending = f.service.invoke(seed());
    await vi.advanceTimersByTimeAsync(500);
    const inv = await pending;
    expect(inv.result.ok).toBe(true); expect(f.requests.map(entry => entry.provider)).toEqual(["compatible", "compatible", "compatible"]);
    expect(Date.now() - before).toBe(500); expect((inv.attemptPath as AttemptRecord[]).map(entry => entry.retry?.delayMs ?? 0)).toEqual([0, 250, 250]);
    expect(f.adapters).toHaveLength(0);
  });

  it("a generic tool_not_found preflight error cannot acquire capability provenance", () => {
    const failure = new ServerToolPreflightError("Tool web_search not found", "openai_responses", "tool_not_found").failure(true);
    expect(failure).toMatchObject({ terminal: true, retryable: false }); expect(failure).not.toHaveProperty("localToolMismatch");
  });

  it.each(["network", "timeout", "model"])("%s failures retain normal retry and backoff", async kind => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5);
    const error = kind === "timeout" ? Object.assign(new Error("headers timeout"), { name: "TimeoutError" }) : new Error("connection reset");
    const f = fixture([{ ...compatible, retry: { maxAttempts: 2, on: ["error"], backoff: { initialMs: 200, maxMs: 200 } } }], {
      reply: (_provider, _body, count) => count === 1 ? kind === "model" ? [] : error : [{ type: "text", text: "done" }],
    });
    const pending = f.service.invoke(seed()); await vi.advanceTimersByTimeAsync(100); const inv = await pending;
    expect(inv.result.ok).toBe(true); expect(f.requests).toHaveLength(2);
    expect(inv.attemptPath).toMatchObject([{ attempt: 1, retry: { suppressed: false } }, { attempt: 2, retry: { delayMs: 100 } }]);
  });

  it.each([false, true])("a capability change after this stage dispatched is terminal (stream=%s)", async stream => {
    vi.useFakeTimers();
    const families: Record<string, Family> = { first: "openai_responses" };
    const f = fixture([{ ...compatible, provider: "first", retry: { maxAttempts: 3, on: ["error"], intervalMs: 250 } }, compatible], {
      families, reply: () => { families.first = "openai_completion"; return 503; },
    });
    const pending = stream ? f.service.stream(seed().withStream(true)) : f.service.invoke(seed());
    await vi.advanceTimersByTimeAsync(250); const inv = await pending;
    expect(inv.result).toMatchObject({ ok: false, terminal: true, status: 400, retryable: false }); expect(inv.result).not.toHaveProperty("localToolMismatch");
    expect(f.visited).toEqual(["first", "first"]); expect(f.requests.map(entry => entry.provider)).toEqual(["first"]);
    expect(inv.attemptPath).toMatchObject([{ attempt: 1, status: 503, retry: { suppressed: false } }, { attempt: 2, status: 400, retry: { delayMs: 250, suppressed: true } }]);
    expect(f.adapters).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("late rendered validation after an attachment request stays terminal", async () => {
    const f = fixture([{ ...compatible, provider: "first", serverToolPolicy: { mode: "blacklist", names: ["external"] } }, compatible], { families: { first: "openai_completion" } });
    const prototype = Object.getPrototypeOf(buildRequest("openai_completion", seed().data())) as Request;
    const render = prototype.render;
    vi.spyOn(prototype, "render").mockImplementation(function (this: Request, target: RenderTarget) {
      const body = render.call(this, target);
      return this.messages.length ? { ...body, tools: [...(body.tools as unknown[] ?? []), { type: "external" }] } : body;
    });
    const request = buildRequest(seed().family, { ...seed().data(), messages: [{ role: "user", content: [{ type: "file", source: { kind: "url", url: "https://files.test/doc.pdf" } }] }] });
    const inv = await f.service.invoke(request, undefined, { serverTools: { tools: [tool()] } });
    expect(inv.result).toMatchObject({ ok: false, terminal: true, retryable: false }); expect(inv.result).not.toHaveProperty("localToolMismatch");
    expect(f.files).toEqual(["https://files.test/doc.pdf"]); expect(f.visited).toEqual(["first"]); expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0);
  });
});

describe("hosted-loop state transitions do not replay adapters", () => {
  it("nested hosted preflight defers to sequential execution and uses the winning map", async () => {
    vi.useFakeTimers();
    const f = fixture([{ ...compatible, provider: "wire" }, compatible], { families: { wire: "openai_completion" } });
    const nested = new HostedToolService(f.service, f.deps, []);
    const inv = await nested.invoke(seed());
    expect(inv.result.ok).toBe(true); expect(f.requests.map(entry => entry.provider)).toEqual(["compatible"]); expect(f.adapters).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a completed local operation is retained once while each new model round fails over", async () => {
    vi.useFakeTimers();
    const f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } }, compatible], {
      reply: (_provider, body) => JSON.stringify(body).includes('"function_call_output"')
        ? [{ type: "text", text: "done" }]
        : [{ type: "tool_use", id: "operation_1", name: "provider_server_side_lookup", input: {} }],
    });
    // first cannot provide web_fetch, compatible passes it natively; both can
    // rewrite web_search. Only the compatible model requests the local tool.
    const run = await runHostedTools(f.service, seed([declared, { type: "web_fetch" }]), [tool()], f.deps.transport, { sessionId: "synthetic" });
    expect(run.value.response.text()).toBe("done"); expect(f.requests.map(entry => entry.provider)).toEqual(["compatible", "compatible"]);
    expect(f.adapters).toHaveLength(1); expect(run.receipts).toHaveLength(1);
    expect(f.requests[1].body.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "operation_1" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["buffered", "stream", "reliable"])("a retained pending adapter waits for the next viable stage (%s)", async mode => {
    vi.useFakeTimers();
    const f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } }, compatible], { reliableStreaming: mode === "reliable" });
    const prepared = prepareServerTools(seed(), { tools: [tool()] });
    const call: ToolUsePart = { type: "tool_use", id: "pending", name: "provider_server_side_lookup", input: {} };
    markLocalToolCall(call, prepared.matched.get(call.name)!);
    const request = buildRequest(seed().family, { ...seed([declared, { type: "web_fetch" }]).data(), messages: [{ role: "assistant", content: [call] }] });
    const before = JSON.stringify(request.data()), clock = Date.now();
    const adapter = f.deps.transport.postStream.bind(f.deps.transport);
    vi.spyOn(f.deps.transport, "postStream").mockImplementation(async (...args) => {
      if (args[0].startsWith("https://adapter.test/")) expect(f.visited.slice(-2)).toEqual(["first", "compatible"]);
      return adapter(...args);
    });
    const run = await runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic", ...(mode !== "buffered" ? { onModelEvent: async () => {} } : {}) });
    expect(run.value.response.text()).toBe("done"); expect(run.attempts).toBe(2);
    expect(run.calls[0].attempts).toMatchObject([{ step: 1, attempt: 1, status: 400 }, { step: 2, attempt: 1, kind: "ok" }]);
    expect(f.requests.map(entry => entry.provider)).toEqual(["compatible"]); expect(f.adapters).toHaveLength(1); expect(f.files).toHaveLength(0);
    expect(run.receipts).toHaveLength(1); expect(run.receipts[0].call.hydrogenTool?.instanceId).toBe(call.hydrogenTool?.instanceId);
    expect(f.requests[0].body.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "pending" }));
    expect(JSON.stringify(request.data())).toBe(before); expect(Date.now()).toBe(clock); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 2, 100])("pending batch follows multiple mismatches exactly once with %s configured attempts", async maxAttempts => {
    vi.useFakeTimers();
    const mismatch = (provider: string) => ({ ...blocked(provider), retry: { ...retry, maxAttempts }, serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } });
    const f = fixture([mismatch("first"), mismatch("middle"), compatible]);
    const { request } = retainedRequest(undefined, 2);
    const run = await runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic" });
    expect(run.calls[0].attempts.map(attempt => [attempt.step, attempt.attempt])).toEqual([[1, 1], [2, 1], [3, 1]]);
    expect(f.requests.map(entry => entry.provider)).toEqual(["compatible"]); expect(f.adapters).toHaveLength(2);
    expect(run.receipts.map(receipt => receipt.call.id)).toEqual(["pending_1", "pending_2"]);
    expect((f.requests[0].body.input as Array<{ type: string }>).filter(part => part.type === "function_call_output")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["policy", "wire"])("all mismatching stages retain the final %s failure and unexecuted pending work", async last => {
    vi.useFakeTimers();
    const first = { ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } };
    const final = last === "policy" ? { ...first, provider: "last" } : { ...compatible, provider: "last" };
    const f = fixture([first, final], { families: { last: last === "wire" ? "openai_completion" : "openai_responses" } });
    const { request } = retainedRequest(); const before = JSON.stringify(request.data());
    await expect(runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic" })).rejects.toMatchObject({ statusCode: 400,
      message: last === "policy" ? "Tool 'web_fetch' not found" : "Tool 'web_fetch' from openai_responses cannot be sent to openai_completion",
      errorBody: { error: { code: last === "policy" ? "tool_not_found" : null } }, calls: [{ attempts: [{ step: 1, attempt: 1 }, { step: 2, attempt: 1 }] }] });
    expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0); expect(f.files).toHaveLength(0);
    expect(JSON.stringify(request.data())).toBe(before); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["buffered", "stream", "reliable"])("ordinary upstream retries after pending execution reuse the receipt (%s)", async mode => {
    vi.useFakeTimers();
    const f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } },
      { ...compatible, retry: { maxAttempts: 2, on: [503], intervalMs: 100 } }], {
      reliableStreaming: mode === "reliable", reply: (_provider, _body, count) => count === 1 ? 503 : [{ type: "text", text: "done" }],
    });
    const { request } = retainedRequest();
    const start = Date.now(), pending = runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic", ...(mode !== "buffered" ? { onModelEvent: async () => {} } : {}) });
    await vi.advanceTimersByTimeAsync(0); expect(f.adapters).toHaveLength(1); expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99); expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); const run = await pending;
    expect(run.attempts).toBe(3); expect(run.receipts).toHaveLength(1); expect(f.adapters).toHaveLength(1);
    expect(f.requests.map(entry => entry.provider)).toEqual(["compatible", "compatible"]);
    for (const entry of f.requests) expect((entry.body.input as Array<{ type: string }>).filter(part => part.type === "function_call_output")).toHaveLength(1);
    expect(Date.now() - start).toBe(100); expect(vi.getTimerCount()).toBe(0);
  });

  it("provider exhaustion and sequential fallback never rerun a completed pending batch", async () => {
    vi.useFakeTimers();
    const f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } },
      { ...compatible, provider: "failure", retry: { maxAttempts: 2, on: [503], intervalMs: 100 } }, compatible], { reply: provider => provider === "failure" ? 503 : [{ type: "text", text: "done" }] });
    const { request } = retainedRequest();
    const pending = runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic" });
    await vi.advanceTimersByTimeAsync(100); const run = await pending;
    expect(run.calls[0].attempts.map(attempt => [attempt.step, attempt.attempt])).toEqual([[1, 1], [2, 1], [2, 2], [3, 1]]);
    expect(f.requests.map(entry => entry.provider)).toEqual(["failure", "failure", "compatible"]); expect(f.adapters).toHaveLength(1);
    expect(run.history.flatMap(message => message.content).filter(part => part.type === "tool_result")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["started", "completed"] as const)("retained %s call without an authoritative result is terminal and never replayed", async execution => {
    vi.useFakeTimers();
    const f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } }, compatible, { ...compatible, provider: "later" }]);
    const { request, calls } = retainedRequest(); calls[0].hydrogenTool!.execution = execution;
    await expect(runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic" })).rejects.toMatchObject({ statusCode: 502,
      message: expect.stringContaining("refusing to replay"), calls: [] });
    expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0); expect(f.files).toHaveLength(0);
    expect(f.visited).toEqual(["first"]); expect(vi.getTimerCount()).toBe(0);
  });

  it("a completed retained result is carried once across mismatch without any adapter call", async () => {
    vi.useFakeTimers();
    const f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } }, compatible]);
    const saved = retainedRequest(); saved.calls[0].hydrogenTool!.execution = "completed";
    const request = buildRequest(saved.request.family, { ...saved.request.data(), messages: [...saved.request.messages, { role: "user", content: [{ type: "tool_result", toolUseId: saved.calls[0].id,
      content: [{ type: "text", text: "saved result" }], hydrogenTool: structuredClone(saved.calls[0].hydrogenTool) }] }] });
    const run = await runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic" });
    expect(f.adapters).toHaveLength(0); expect(f.requests.map(entry => entry.provider)).toEqual(["compatible"]);
    expect(f.requests[0].body.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "pending_1", output: "saved result" }));
    expect(run.history.flatMap(message => message.content).filter(part => part.type === "tool_result")).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["nested", "agent"])("pending execution remains once through the %s wrapper", async wrapper => {
    vi.useFakeTimers();
    const f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } }, compatible]);
    const nested = new HostedToolService(f.service, f.deps, []);
    const executor = wrapper === "nested" ? nested : new MicroAgent(parseService({ kind: "micro_agent", timeoutMs: 1000, stages: [{ name: "selected", service: "leaf" }] }) as AgentDef,
      { ...f.deps, resolver: { resolve: () => ({ ok: true, executor: nested, isAgent: false }), sttDef: () => ({ ok: false, message: "unused" }) }, logMaxChars: 1000 });
    const { request } = retainedRequest();
    const run = await runHostedTools(executor, request, [tool()], f.deps.transport, { sessionId: "synthetic" });
    expect(run.attempts).toBe(2); expect(run.receipts).toHaveLength(1); expect(f.adapters).toHaveLength(1);
    expect(f.requests.map(entry => entry.provider)).toEqual(["compatible"]);
    expect((f.requests[0].body.input as Array<{ type: string }>).filter(part => part.type === "function_call_output")).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1])("pending execution respects shared round boundary %s", async remainingRounds => {
    vi.useFakeTimers();
    const f = fixture([compatible]); const { request } = retainedRequest([declared]);
    const hosted = { sessionId: "synthetic", remainingCalls: 2, remainingRounds, traces: [] };
    if (!remainingRounds) {
      await expect(runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic", hosted })).rejects.toMatchObject({ statusCode: 402 });
      expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0);
    } else {
      const run = await runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic", hosted });
      expect(run.attempts).toBe(1); expect(f.requests).toHaveLength(1); expect(f.adapters).toHaveLength(1); expect(hosted.remainingRounds).toBe(0); expect(hosted.remainingCalls).toBe(1);
    }
    expect(hosted).toHaveProperty("callLimits", []); expect(vi.getTimerCount()).toBe(0);
  });

  it("saved pending executor cannot be replaced by a newly offered same-name adapter", async () => {
    vi.useFakeTimers();
    const replacement = { ...tool(), id: 43, url: "https://adapter.test/replacement", serverTool: { ...tool().serverTool!, name: "web_fetch" } };
    const f = fixture([compatible]); const { request, calls } = retainedRequest([{ type: "web_fetch" }]);
    const adapter = f.deps.transport.postStream.bind(f.deps.transport), urls: string[] = [];
    vi.spyOn(f.deps.transport, "postStream").mockImplementation(async (...args) => { if (args[0].startsWith("https://adapter.test/")) urls.push(args[0]); return adapter(...args); });
    const run = await runHostedTools(f.service, request, [tool(), replacement], f.deps.transport, { sessionId: "synthetic" });
    expect(urls).toEqual(["https://adapter.test/run"]); expect(run.receipts[0].entry.tool.id).toBe(42);
    expect(run.receipts[0].call.hydrogenTool?.instanceId).toBe(calls[0].hydrogenTool?.instanceId); expect(f.requests).toHaveLength(1);
  });

  it.each([undefined, "started", "completed"] as const)("missing/disabled exact owner never rebinds or erases lifecycle=%s", async execution => {
    vi.useFakeTimers();
    for (const mismatch of [false, true]) for (const disabled of [false, true]) {
      const f = fixture(mismatch ? [{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } }, compatible] : [compatible]);
      const { request, calls } = retainedRequest(mismatch ? undefined : [declared]); calls[0].hydrogenTool!.execution = execution;
      const before = JSON.stringify(request.data());
      const availability = disabled ? [{ ...tool(), enabled: false }] : [{ ...tool(), id: 77, url: "https://adapter.test/new" }];
      await expect(runHostedTools(f.service, request, availability, f.deps.transport, { sessionId: "synthetic" })).rejects.toMatchObject({ statusCode: 400,
        message: "The retained tool executor is unavailable; start a new session" });
      expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0); expect(f.files).toHaveLength(0);
      expect(JSON.stringify(request.data())).toBe(before); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("an absent child owner may be deferred but its pending work cannot disappear from the final run", async () => {
    vi.useFakeTimers();
    const f = fixture([compatible]); const { request } = retainedRequest([]);
    await expect(runHostedTools(f.service, request, [], f.deps.transport, { sessionId: "synthetic" })).rejects.toMatchObject({ statusCode: 502,
      message: expect.stringContaining("refusing to discard pending work") });
    expect(f.adapters).toHaveLength(0); expect(f.requests).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["duplicates", "binding"])("global %s validation precedes pending adapter execution", async invalid => {
    vi.useFakeTimers();
    const f = fixture([blocked("first"), { ...compatible, overrides: { extra: { tools: [] } } }]);
    const { request } = retainedRequest(invalid === "duplicates" ? [declared, declared] : [declared]);
    const tools = invalid === "binding" ? [tool(), { ...tool(), id: 43, name: "other" }] : [tool()];
    await expect(runHostedTools(f.service, request, tools, f.deps.transport, { sessionId: "synthetic" })).rejects.toMatchObject({ statusCode: 400,
      errorBody: { error: { code: "hydrogen_tool_name_conflict" } } });
    expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0); expect(f.files).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("cancellation after a partial pending batch never reaches a model retry or replays the completed call", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } }, compatible, { ...compatible, provider: "later" }]);
    const { request } = retainedRequest(undefined, 2), before = JSON.stringify(request.data());
    const adapter = f.deps.transport.postStream.bind(f.deps.transport); let starts = 0;
    vi.spyOn(f.deps.transport, "postStream").mockImplementation(async (...args) => {
      if (args[0].startsWith("https://adapter.test/") && ++starts === 2) { controller.abort(); throw new Error("Synthetic cancelled outcome unknown"); }
      return adapter(...args);
    });
    const completed: string[] = [];
    await expect(runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic", signal: controller.signal,
      emit: async event => { if (event.type === "hydrogen.tool.completed") completed.push(String(event.model_call_id)); } })).rejects.toMatchObject({ statusCode: 499,
      calls: [{ attempts: [{ step: 1, attempt: 1 }, { step: 2, attempt: 1 }] }] });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(starts).toBe(2); expect(completed).toEqual(["pending_1"]); expect(f.adapters).toHaveLength(1); expect(f.requests).toHaveLength(0);
    expect(JSON.stringify(request.data())).toBe(before); expect(vi.getTimerCount()).toBe(0);
  });

  it("an adapter's connection-error receipt is never retried with model retries", async () => {
    vi.useFakeTimers();
    const f = fixture([{ ...compatible, retry: { maxAttempts: 2, on: [503], intervalMs: 100 } }], { reply: (_provider, _body, count) => count === 1 ? 503 : [{ type: "text", text: "done" }] });
    let attempts = 0; const adapter = f.deps.transport.postStream.bind(f.deps.transport);
    vi.spyOn(f.deps.transport, "postStream").mockImplementation(async (...args) => { if (args[0].startsWith("https://adapter.test/")) { attempts++; throw new Error("Synthetic connection outcome unknown"); } return adapter(...args); });
    const { request } = retainedRequest([declared]);
    const pending = runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic" });
    await vi.advanceTimersByTimeAsync(100); const run = await pending;
    expect(attempts).toBe(1); expect(f.requests).toHaveLength(2); expect(run.receipts).toHaveLength(1); expect(run.receipts[0].result.isError).toBe(true);
    expect(run.receipts[0].result.content).toEqual([{ type: "text", text: JSON.stringify({ error: { code: "tool_connection_error", message: "Tool API request failed" } }) }]);
    expect(run.receipts[0].call.hydrogenTool?.execution).toBe("completed"); expect(vi.getTimerCount()).toBe(0);
  });

  it("known unsafe work anywhere in the retained batch prevents every new side effect", async () => {
    vi.useFakeTimers(); const f = fixture([compatible]); const { request, calls } = retainedRequest([declared], 2);
    calls[1].hydrogenTool!.execution = "started";
    await expect(runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic" })).rejects.toMatchObject({ statusCode: 502, calls: [] });
    expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("completed raw/native history stays completed without acquiring private ownership or replay", async () => {
    vi.useFakeTimers(); const f = fixture([compatible]);
    const request = buildRequest(seed().family, { ...seed().data(), messages: [{ role: "assistant", content: [{ type: "tool_use", id: "raw", name: "web_search", input: {}, serverTool: true }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "raw", content: [{ type: "text", text: "existing result" }] }] }] });
    const run = await runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic" });
    expect(f.adapters).toHaveLength(0); expect(f.requests).toHaveLength(1); expect(run.receipts).toHaveLength(0);
    expect(run.history[0].content[0]).not.toHaveProperty("hydrogenTool"); expect(vi.getTimerCount()).toBe(0);
  });

  it("a pending receipt crossing the existing context limit stops before model/attachment dispatch", async () => {
    vi.useFakeTimers(); const f = fixture([compatible]), saved = retainedRequest([declared]);
    const padding = { type: "text" as const, text: "" };
    const messages = [...saved.request.messages, { role: "user" as const, content: [padding] }];
    padding.text = "x".repeat(25 * 1024 * 1024 - 1024 - Buffer.byteLength(JSON.stringify(messages)));
    const request = buildRequest(saved.request.family, { ...saved.request.data(), messages });
    const adapter = f.deps.transport.postStream.bind(f.deps.transport); let executed = 0, retained = 0;
    vi.spyOn(f.deps.transport, "postStream").mockImplementation(async (...args) => {
      if (args[0].startsWith("https://adapter.test/")) { executed++; return { status: 200, headers: {}, body: Readable.from([JSON.stringify({ results: ["y".repeat(4096)] })]) }; }
      return adapter(...args);
    });
    await expect(runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic", onPendingToolExecution: async (_call, result) => {
      if (result) retained++; return { ok: true, value: undefined };
    } })).rejects.toMatchObject({ statusCode: 413, calls: [{ attempts: [{ step: 1, attempt: 1, status: 413 }] }] });
    expect(executed).toBe(1); expect(retained).toBe(1); expect(f.requests).toHaveLength(0); expect(f.files).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("pending call-limit exhaustion becomes one retained result without adapter IO", async () => {
    vi.useFakeTimers();
    const f = fixture([compatible]); const { request } = retainedRequest([declared]);
    const hosted = { sessionId: "synthetic", remainingCalls: 0, remainingRounds: 1, traces: [] };
    const run = await runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic", hosted });
    expect(f.adapters).toHaveLength(0); expect(f.requests).toHaveLength(1); expect(run.receipts).toHaveLength(1);
    expect(run.receipts[0].result).toMatchObject({ isError: true, hydrogenTool: { execution: "completed" } });
    expect(JSON.stringify(run.receipts[0].result.content)).toContain("tool_call_limit"); expect(hosted.remainingCalls).toBe(0); expect(hosted.remainingRounds).toBe(0);
  });

  it.each(["ocr", "asr"].flatMap(kind => [false, true].map(retryChild => ({ kind, retryChild }))))("tool-free internal $kind uses independent retry=$retryChild before outer mismatch failover", async ({ kind, retryChild }) => {
    vi.useFakeTimers();
    const f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } }, compatible], {
      reply: (provider, _body, count) => retryChild && provider === "prepass" && count === 1 ? 503 : [{ type: "text", text: provider === "prepass" ? '[{"index":1,"image":"OCR text"}]' : "done" }],
    });
    const childStep = { ...blocked("prepass"), retry: { maxAttempts: 2, on: ["error"], intervalMs: 100 } };
    const child = new ModelService(parseServiceSteps({ steps: [childStep] }), f.deps);
    const childInvoke = vi.spyOn(child, "invoke");
    const raw: Buffer[] = [];
    Object.assign(f.deps.catalog, { resolveWithin: () => ({ ok: true, target: { upstreamModel: "speech", upstream: { type: "openai_completion", baseUrl: "https://provider.test/prepass", apiKey: "synthetic" } } }) });
    Object.assign(f.deps.transport, { postRaw: async (_url: string, _headers: unknown, body: Buffer) => { raw.push(body); return retryChild && raw.length === 1
      ? { status: 503, headers: {}, json: { error: { code: "tool_not_found", message: "upstream tool error lookalike" } }, text: "" }
      : { status: 200, headers: {}, json: { text: "ASR text" }, text: "" }; } });
    const agent = new MicroAgent(parseService({ kind: "micro_agent", [kind]: { service: "prepass" }, stages: [{ name: "model", service: "model" }] }) as AgentDef,
      { ...f.deps, logMaxChars: 1000, resolver: { resolve: name => ({ ok: true, executor: name === "prepass" ? child : f.service, isAgent: false }), sttDef: () => ({ ok: true, def: parseServiceSteps({ steps: [childStep] }) }) } });
    const content: ContentPart = kind === "ocr" ? { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA==" } }
      : { type: "opaque", family: "openai_completion", value: { type: "input_audio", input_audio: { data: "AA==", format: "wav" } } };
    const outer = seed([declared, { type: "web_fetch" }, { type: "function", name: "client", parameters: {} }]).withOverrides({ extra: { tool_choice: { type: "function", name: "client" } } });
    const request = buildRequest(outer.family, { ...outer.data(), messages: [{ role: "user", content: [content] }] });
    const before = Date.now();
    const pending = agent.invoke(request, undefined, { serverTools: { tools: [tool()] } });
    await vi.advanceTimersByTimeAsync(retryChild ? 100 : 0); const inv = await pending;
    expect(inv.result.ok).toBe(true);
    expect(f.requests.map(entry => entry.provider)).toEqual(kind === "ocr" ? [...Array(retryChild ? 2 : 1).fill("prepass"), "compatible"] : ["compatible"]);
    if (kind === "ocr") {
      const [input, , opts] = childInvoke.mock.calls[0];
      expect(input.tools).toBeUndefined(); expect(input.toolChoice).toBeUndefined();
      expect(input.params.extra).toBeUndefined(); expect(input.params.passthrough).toBeUndefined();
      expect(opts?.hosted).toBeUndefined(); expect(opts?.serverTools?.tools ?? []).toEqual([]);
      expect(f.requests[0].body.tools).toBeUndefined(); expect(f.requests[0].body.tool_choice).toBeUndefined();
      expect(raw).toHaveLength(0);
    } else {
      expect(childInvoke).not.toHaveBeenCalled(); expect(raw).toHaveLength(retryChild ? 2 : 1);
      for (const value of raw) { const body = value.toString(); expect(body).toContain('name="model"'); expect(body).toContain('name="file"');
        expect(body).not.toContain("tool"); expect(body).not.toContain("client"); }
    }
    const sent = f.requests.at(-1)!.body;
    expect(JSON.stringify(sent.input)).toContain(kind === "ocr" ? "OCR text" : "ASR text");
    expect(sent.tools).toContainEqual(expect.objectContaining({ name: "provider_server_side_lookup" }));
    expect(sent.tool_choice).toEqual({ type: "function", name: "client" });
    expect(f.adapters).toHaveLength(0); expect(f.files).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    const paths = inv.attemptPath as Array<{ stage: string; attempts: AttemptRecord[] }>;
    expect(paths[0].attempts.map(entry => entry.attempt)).toEqual(retryChild ? [1, 2] : [1]);
    expect(paths.at(-1)?.attempts.map(entry => [entry.step, entry.attempt])).toEqual([[1, 1], [2, 1]]);
    expect(Date.now() - before).toBe(retryChild ? 100 : 0);
  });

  it("internal OCR hosted context does not spend the outer declared-tool budget", async () => {
    const f = fixture([compatible], { reply: provider => [{ type: "text", text: provider === "prepass" ? '[{"index":1,"image":"OCR text"}]' : "done" }] });
    const child = new ModelService(parseServiceSteps({ steps: [{ ...compatible, provider: "prepass" }] }), f.deps);
    const inner = vi.spyOn(child, "invoke");
    const hosted = new HostedToolService(child, f.deps, [{ ...tool(), id: 77 }]);
    const context = { sessionId: "outer", remainingCalls: 7, remainingRounds: 11, traces: [] };
    const agent = new MicroAgent(parseService({ kind: "micro_agent", ocr: { service: "prepass" }, stages: [{ name: "model", service: "model" }] }) as AgentDef,
      { ...f.deps, logMaxChars: 1000, resolver: { resolve: name => ({ ok: true, executor: name === "prepass" ? hosted : f.service, isAgent: false }), sttDef: () => ({ ok: false, message: "unused" }) } });
    const request = buildRequest(seed().family, { ...seed().data(), messages: [{ role: "user", content: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA==" } }] }] });
    const inv = await agent.invoke(request, undefined, { hosted: context, serverTools: { tools: [tool()] }, callerToolValidation: { request }, serverToolRound: 3 });
    expect(inv.result.ok).toBe(true); expect(context.remainingRounds).toBe(11); expect(context.remainingCalls).toBe(7); expect(context.traces).toEqual([]);
    const options = inner.mock.calls[0][2];
    expect(options?.hosted).not.toBe(context); expect(options?.callerToolValidation?.request).not.toBe(request);
    expect(options?.serverTools?.tools.map(entry => entry.id)).toEqual([77]);
    expect(f.requests[0].body.tools).toBeUndefined(); expect(f.requests[0].body.tool_choice).toBeUndefined();
    expect(f.adapters).toHaveLength(0);
    if (inv.result.ok) expect(inv.result.value.response.usage).toMatchObject({ totalTokens: 4 });
  });

  it.each(["ocr", "asr"].flatMap(kind => [false, true].map(cancel => ({ kind, cancel }))))("internal $kind exhaustion/cancellation=$cancel never dispatches outer stages", async ({ kind, cancel }) => {
    vi.useFakeTimers();
    const f = fixture([blocked("first"), compatible], { reply: () => 503 });
    const childDef = parseServiceSteps({ steps: [{ ...compatible, provider: "prepass", retry: { maxAttempts: 2, on: ["error"], intervalMs: 100 } }] });
    const child = new ModelService(childDef, f.deps);
    const raw: Buffer[] = [];
    Object.assign(f.deps.catalog, { resolveWithin: () => ({ ok: true, target: { upstreamModel: "speech", upstream: { type: "openai_completion", baseUrl: "https://provider.test/prepass", apiKey: "synthetic" } } }) });
    Object.assign(f.deps.transport, { postRaw: async (_url: string, _headers: unknown, body: Buffer) => { raw.push(body); return { status: 503, headers: {}, json: { error: { message: "upstream unavailable" } }, text: "" }; } });
    const agent = new MicroAgent(parseService({ kind: "micro_agent", [kind]: { service: "prepass" }, stages: [{ name: "model", service: "model" }] }) as AgentDef,
      { ...f.deps, logMaxChars: 1000, resolver: { resolve: name => ({ ok: true, executor: name === "prepass" ? child : f.service, isAgent: false }), sttDef: () => ({ ok: true, def: childDef }) } });
    const content: ContentPart = kind === "ocr" ? { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA==" } }
      : { type: "opaque", family: "openai_completion", value: { type: "input_audio", input_audio: { data: "AA==", format: "wav" } } };
    const request = buildRequest(seed().family, { ...seed().data(), messages: [{ role: "user", content: [content] }] });
    const before = Date.now(), controller = new AbortController();
    const context = { sessionId: "outer", remainingCalls: 7, remainingRounds: 11, traces: [] };
    const pending = agent.invoke(request, undefined, { signal: controller.signal, hosted: context });
    await vi.advanceTimersByTimeAsync(0);
    if (cancel) controller.abort(); else await vi.advanceTimersByTimeAsync(100);
    const inv = await pending;
    expect(inv.result).toMatchObject({ ok: false, status: 503 }); expect(inv.result).not.toHaveProperty("localToolMismatch");
    expect(f.requests.map(entry => entry.provider)).toEqual(kind === "ocr" ? Array(cancel ? 1 : 2).fill("prepass") : []);
    expect(raw).toHaveLength(kind === "asr" ? cancel ? 1 : 2 : 0);
    expect((inv.attemptPath as Array<{ stage: string; attempts: AttemptRecord[] }>).map(call => call.stage)).toEqual([`(${kind})`]);
    expect(context).toMatchObject({ remainingCalls: 7, remainingRounds: 11, traces: [] });
    expect(Date.now() - before).toBe(cancel ? 0 : 100); expect(f.adapters).toHaveLength(0); expect(f.files).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100); // drain the existing retry sleep after cancellation
    expect(f.requests.some(entry => entry.provider === "compatible" || entry.provider === "first")).toBe(false);
  });

  it.each(["buffered", "stream", "hosted", "hosted-buffered", "hosted-stream"])("completed internal OCR usage survives all outer mismatches (%s)", async mode => {
    const f = fixture([blocked("first"), blocked("last")], { reply: () => [{ type: "text", text: '[{"index":1,"image":"OCR text"}]' }] });
    const child = new ModelService(parseServiceSteps({ steps: [{ ...compatible, provider: "prepass" }] }), f.deps);
    const agent = new MicroAgent(parseService({ kind: "micro_agent", ocr: { service: "prepass" }, stages: [{ name: "model", service: "model" }] }) as AgentDef,
      { ...f.deps, logMaxChars: 1000, resolver: { resolve: name => ({ ok: true, executor: name === "prepass" ? child : f.service, isAgent: false }), sttDef: () => ({ ok: false, message: "unused" }) } });
    const request = buildRequest(seed().family, { ...seed().data(), messages: [{ role: "user", content: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA==" } }] }] });
    if (mode === "hosted") {
      await expect(runHostedTools(agent, request, [], f.deps.transport, { sessionId: "synthetic", emit: async () => {}, config: HostedToolOptionsSchema.parse({ streamMode: "all" }) }))
        .rejects.toMatchObject({ statusCode: 400, usage: { totalTokens: 2 } });
    } else {
      const executor = mode.startsWith("hosted-") ? new HostedToolService(agent, f.deps, []) : agent;
      const inv = mode.endsWith("stream") ? await executor.stream(request.withStream(true)) : await executor.invoke(request);
      expect(inv.result).toMatchObject({ ok: false, status: 400, usage: { totalTokens: 2 } });
      if ("usage" in inv) expect(inv.usage).toMatchObject({ totalTokens: 2 });
      expect(inv.attempts).toBe(3); // one child send, then two outer local attempts
    }
    expect(f.requests.map(entry => entry.provider)).toEqual(["prepass"]); expect(f.adapters).toHaveLength(0);
  });

  it.each([false, true])("stateless stream=%s cancellation accounts completed OCR once", async stream => {
    vi.useFakeTimers();
    const raw = Object.assign(new EventEmitter(), { writableFinished: false, headersSent: false, writableEnded: false, destroy: vi.fn() });
    const f = fixture([compatible], { reply: provider => {
      if (provider === "prepass") return [{ type: "text", text: '[{"index":1,"image":"OCR text"}]' }];
      raw.emit("close"); return 503;
    } });
    const child = new ModelService(parseServiceSteps({ steps: [{ ...compatible, provider: "prepass" }] }), f.deps);
    const definition = parseService({ kind: "micro_agent", ocr: { service: "prepass" }, stages: [{ name: "model", service: "model" }] }) as AgentDef;
    const agent = new MicroAgent(definition, { ...f.deps, logMaxChars: 1000,
      resolver: { resolve: name => ({ ok: true, executor: name === "prepass" ? child : f.service, isAgent: false }), sttDef: () => ({ ok: false, message: "unused" }) } });
    const logs: LogParams[] = [], record = vi.fn(), activeRequests = new ActiveRequestRegistry();
    const deps = { ...f.deps, services: { getByName: () => ({ id: 7, enabled: true }), def: () => definition }, factory: { forRow: () => ({ executor: agent }) },
      logger: { capture: (value: unknown) => JSON.stringify(value), record: (value: LogParams) => logs.push(value) }, usage: { record }, activeRequests, streamCommitGraceMs: 600_000 } as unknown as ProxyDeps;
    const controller = new ProxyController(deps);
    const req = { url: "/v1/responses", method: "POST", headers: {}, clientToken: { id: 1, scopeServices: [7] }, body: {
      model: "agent", stream, tools: [declared], input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
    } } as unknown as FastifyRequest;
    const hijack = vi.fn(), reply = { raw, hijack } as unknown as FastifyReply;
    // Inject the already-authenticated controller boundary; real scoped HTTP
    // authorization is covered separately by the disposable validation script.
    const owned = controller as unknown as { handleChatOwned(req: FastifyRequest, reply: FastifyReply, ingress: Family): Promise<unknown> };
    await owned.handleChatOwned(req, reply, "openai_responses");
    expect(logs).toHaveLength(1); expect(logs[0]).toMatchObject({ httpStatus: 499, usage: { totalTokens: 2 } });
    expect(record.mock.calls).toEqual([[1, 2]]); expect(hijack).toHaveBeenCalledTimes(1); expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(activeRequests.listActive()).toHaveLength(0); expect(f.requests.map(entry => entry.provider)).toEqual(["prepass", "compatible"]);
    expect(f.adapters).toHaveLength(0); expect(f.files).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.requests).toHaveLength(2); expect(record).toHaveBeenCalledTimes(1);
  });
});
