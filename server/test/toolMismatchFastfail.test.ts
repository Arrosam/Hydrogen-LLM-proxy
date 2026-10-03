import { Readable } from "node:stream";
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
import { parseService, type AgentDef } from "../src/execution/definition";
import { runHostedTools } from "../src/execution/hostedToolLoop";
import { HttpToolSchema } from "../src/execution/toolHttp";
import { markLocalToolCall, prepareServerTools, ServerToolPreflightError, validateServerToolInput } from "../src/execution/serverTools";
import type { ToolUsePart } from "../src/core/ir/content";
import { runSteps, type AttemptFailure, type AttemptRecord } from "../src/execution/steps";

const declared = { type: "web_search" };
const seed = (tools: unknown[] = [declared]) => parseRequest("openai_responses", { model: "svc", input: "hello", tools });
const retry = { maxAttempts: 100, on: ["error"], intervalMs: 600_000, backoff: { initialMs: 600_000, maxMs: 600_000 } };
const blocked = (provider: string) => ({ model: "m", provider, retry, advanceOn: [], serverToolPolicy: { mode: "whitelist", names: [] } });
const compatible = { model: "m", provider: "compatible", retry };
const tool = () => ({ ...HttpToolSchema.parse({ name: "lookup", url: "https://adapter.test/run", parameters: { type: "object" },
  bodyTemplate: {}, serverTool: { name: "web_search", resultPath: "/results" } }), id: 42 });

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

  it("a deferred mismatch cannot dispatch a privately retained pending adapter call", async () => {
    const f = fixture([{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } }, compatible]);
    const prepared = prepareServerTools(seed(), { tools: [tool()] });
    const call: ToolUsePart = { type: "tool_use", id: "pending", name: "provider_server_side_lookup", input: {} };
    markLocalToolCall(call, prepared.matched.get(call.name)!);
    const request = buildRequest(seed().family, { ...seed([declared, { type: "web_fetch" }]).data(), messages: [{ role: "assistant", content: [call] }] });
    const before = JSON.stringify(request.data());
    await expect(runHostedTools(f.service, request, [tool()], f.deps.transport, { sessionId: "synthetic" })).rejects.toMatchObject({ statusCode: 400 });
    expect(JSON.stringify(request.data())).toBe(before); expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0);
  });

  it.each(["ocr", "asr"])("deferred mismatch preserves the %s prepass rejection boundary", async kind => {
    const f = fixture([blocked("first"), compatible]);
    const agent = new MicroAgent(parseService({ kind: "micro_agent", [kind]: { service: "prepass" }, stages: [{ name: "model", service: "model" }] }) as AgentDef,
      { ...f.deps, logMaxChars: 1000, resolver: { resolve: () => ({ ok: true, executor: f.service, isAgent: false }), sttDef: () => ({ ok: true, def: parseServiceSteps({ steps: [compatible] }) }) } });
    const content: ContentPart = kind === "ocr" ? { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA==" } }
      : { type: "opaque", family: "openai_completion", value: { type: "input_audio", input_audio: { data: "AA==", format: "wav" } } };
    const request = buildRequest(seed().family, { ...seed().data(), messages: [{ role: "user", content: [content] }] });
    const inv = await agent.invoke(request);
    expect(inv.result).toMatchObject({ ok: false, terminal: true, status: 400 }); expect(inv.result).not.toHaveProperty("localToolMismatch");
    expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0); expect(f.files).toHaveLength(0);
  });
});
