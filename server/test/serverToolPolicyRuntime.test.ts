import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import "../src/core/format";
import { buildRequest, buildResponse, parseRequest, serializeStream } from "../src/core/format/registry";
import { fabricateStream } from "../src/core/ir/stream";
import type { ContentPart, Message, ToolResultPart, ToolUsePart } from "../src/core/ir/content";
import type { Family } from "../src/core/ir/params";
import type { Request } from "../src/core/ir/request";
import type { Transport } from "../src/core/upstream/transport";
import type { Catalog } from "../src/catalog/catalog";
import { ModelService } from "../src/execution/modelService";
import { MicroAgent } from "../src/execution/microAgent";
import { HostedToolService } from "../src/execution/hostedToolService";
import { HostedToolOptionsSchema, parseService, type AgentDef, type ServerToolPolicy, type ServiceSteps } from "../src/execution/definition";
import { runHostedTools } from "../src/execution/hostedToolLoop";
import { HttpToolSchema, type HttpTool } from "../src/execution/toolHttp";
import { collectServerToolCalls, markLocalToolCall, prepareServerTools, retainServerToolReceipts, serverToolParts, serverToolResponseContent, ServerToolPreflightError, type HostedToolReceipt } from "../src/execution/serverTools";

const emitted = "provider_server_side_lookup";
const raw = { type: "web_search", search_context_size: "low" };
const tool = (patch: Partial<HttpTool> = {}): HttpTool => ({ ...HttpToolSchema.parse({ name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  url: "https://adapter.test/run", bodyTemplate: { q: "{{arguments.q}}" }, serverTool: { name: "web_search", resultPath: "/results" } }), id: 42, ...patch });
const seed = (tools: unknown[] = [raw], family: Family = "openai_responses") => parseRequest(family,
  family === "anthropic" ? { model: "svc", messages: [{ role: "user", content: "q" }], tools, max_tokens: 100 }
    : { model: "svc", input: "q", messages: [{ role: "user", content: "q" }], tools });
const definition = (patch: Partial<ServiceSteps> = {}): ServiceSteps => parseService({ timeoutMs: 1000,
  steps: [{ model: "m", provider: "p", retry: { maxAttempts: 1 } }], ...patch }) as ServiceSteps;

/** Real format parsing/rendering and executor code, entirely fake transport.
 * Requests and adapter side effects have separate observable counters. */
function fixture(opts: {
  family?: Family; families?: Record<string, Family>; fail?: string[]; prefix?: string;
  answer?: (body: Record<string, unknown>, provider: string) => ContentPart[];
} = {}) {
  const requests: Array<{ provider: string; family: Family; body: Record<string, unknown>; stream: boolean }> = [];
  const adapters: Array<{ body: Record<string, unknown>; url: string }> = [];
  const routes = new Map<string, { provider: string; family: Family }>();
  const catalog = { resolve: (_model: string, provider: string) => {
    const family = opts.families?.[provider] ?? opts.family ?? "openai_responses";
    const url = `https://provider.test/${provider}`;
    routes.set(url, { provider, family });
    return { ok: true, target: { family, url, headers: {}, upstream: {}, upstreamModel: "up", modelName: "m", providerName: provider } };
  } } as unknown as Catalog;
  const modelReply = (url: string, body: Record<string, unknown>, stream: boolean) => {
    const { provider, family } = routes.get(url)!;
    requests.push({ provider, family, body: structuredClone(body), stream });
    const offered = (body.tools ?? []) as Array<Record<string, unknown>>;
    const local = offered.map(entry => String((entry.function as Record<string, unknown> | undefined)?.name ?? entry.name ?? ""))
      .find(name => name === (opts.prefix ?? "provider_server_side_") + "lookup");
    const content = opts.answer?.(body, provider) ?? (local && !JSON.stringify(body).includes('"call_1"')
      ? [{ type: "tool_use", id: "call_1", name: local, input: { q: "hello" } }]
      : [{ type: "text", text: "done" }]);
    return { family, content, failed: opts.fail?.includes(provider) ?? false };
  };
  const response = (family: Family, content: ContentPart[]) => buildResponse(family, {
    id: "upstream", model: "up", created: 1, content,
    stopReason: content.some(part => part.type === "tool_use") ? "tool_use" : "stop", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
  });
  const transport: Transport = {
    async postJson(url, _headers, body) {
      const reply = modelReply(url, body, false);
      return { status: reply.failed ? 503 : 200, headers: {}, text: "", json: reply.failed ? { error: { message: "fixture unavailable" } } : response(reply.family, reply.content).renderSelf("up") };
    },
    async postStream(url, _headers, body) {
      if (url.startsWith("https://adapter.test/")) {
        adapters.push({ url, body: structuredClone(body) });
        return { status: 200, headers: {}, body: Readable.from(['{"results":[{"url":"https://example.test/","title":"fixture"}]}']) };
      }
      const reply = modelReply(url, body, true);
      return { status: reply.failed ? 503 : 200, headers: {}, body: reply.failed ? Readable.from(['{"error":{"message":"fixture unavailable"}}'])
        : Readable.from(serializeStream(reply.family, fabricateStream(response(reply.family, reply.content).data(), Infinity), { model: "up" })) };
    },
  };
  const deps = { catalog, transport, ...(opts.prefix !== undefined ? { serverToolNamePrefix: opts.prefix } : {}) };
  return { requests, adapters, deps, service: (def = definition()) => new ModelService(def, deps) };
}

function nestedReceiptGraph(opts: { siblingReusesId?: boolean; output?: string } = {}) {
  const callId = "shared_provider_id", nameA = "provider_server_side_lookup_A", nameB = "provider_server_side_lookup_B";
  const f = fixture({ answer: (body, provider) => {
    const input = (body.input ?? []) as Array<Record<string, unknown>>;
    const completed = input.some(item => item.type === "function_call_output" && item.call_id === callId);
    const pendingB = input.some(item => item.type === "function_call" && item.call_id === callId && item.name === nameB);
    if (provider === "B" && !completed) return [{ type: "tool_use", id: callId, name: nameB, input: { q: "B" } }];
    if (provider === "A" && opts.siblingReusesId && pendingB && !completed) return [{ type: "tool_use", id: callId, name: nameA, input: { q: "A" } }];
    return [{ type: "text", text: "answer " + provider }];
  } });
  const a = tool({ id: 43, name: "lookup_A", url: "https://adapter.test/A" });
  const b = tool({ id: 44, name: "lookup_B", url: "https://adapter.test/B" });
  const childA = new HostedToolService(f.service(definition({ steps: [{ model: "m", provider: "A",
    ...(opts.siblingReusesId ? { overrides: { extra: { tools: [raw] } } } : {}) }] })), f.deps, [a], HostedToolOptionsSchema.parse({ maxRounds: 2 }));
  const childB = new HostedToolService(f.service(definition({ steps: [{ model: "m", provider: "B" }] })), f.deps, [b], HostedToolOptionsSchema.parse({ maxRounds: 1 }));
  const agent = new MicroAgent(parseService({ kind: "micro_agent", timeoutMs: 1000,
    stages: [{ name: "first", service: "A" }, { name: "second", service: "B" }], ...(opts.output ? { output: opts.output } : {}) }) as AgentDef,
  { ...f.deps, logMaxChars: 1000, resolver: { sttDef: () => ({ ok: false, message: "unused" }),
    resolve: name => ({ ok: true, executor: name === "A" ? childA : childB, isAgent: false }) } });
  return { ...f, agent, a, b, callId, nameA, nameB };
}

describe("nested completed execution receipts", () => {
  it.each([false, true])("retains only an exposed pending child call across three turns (stream=%s)", async stream => {
    const f = nestedReceiptGraph({ siblingReusesId: true });
    const options = { sessionId: "s", config: HostedToolOptionsSchema.parse({ maxRounds: 1, streamMode: stream ? "all" : "final" }),
      ...(stream ? { emit: async () => {} } : {}) };
    const first = await runHostedTools(f.agent, seed().withStream(stream), [], f.deps.transport, options);
    expect(first.paused).toBe(true); expect(f.adapters).toHaveLength(0);
    const pendingB = first.history.flatMap(message => message.content).find((part): part is ToolUsePart => part.type === "tool_use");
    expect(pendingB).toMatchObject({ id: f.callId, name: f.nameB, hydrogenTool: { id: f.b.id, instanceId: expect.any(String) } });
    const secondRequest = buildRequest("openai_responses", { ...seed([]).data(), stream, messages: [...first.history, { role: "user", content: [{ type: "text", text: "continue" }] }] });
    const original = JSON.stringify(secondRequest.data());
    const second = await runHostedTools(f.agent, secondRequest, [], f.deps.transport, options);
    expect(JSON.stringify(secondRequest.data())).toBe(original);
    expect(second.value.response.text()).toBe("answer B");
    expect(f.adapters.map(adapter => adapter.url)).toEqual(["https://adapter.test/A", "https://adapter.test/B"]);
    const receipts = second.value.hostedToolReceipts!;
    expect(receipts).toHaveLength(2);
    expect(receipts.map(receipt => receipt.call.id)).toEqual([f.callId, f.callId]);
    expect(new Set(receipts.map(receipt => receipt.call.hydrogenTool!.instanceId)).size).toBe(2);
    expect(second.history.flatMap(message => message.content).filter(part => part.type === "tool_use")).toHaveLength(1);
    const retained = second.history.flatMap(message => message.content).filter((part): part is ToolResultPart => part.type === "tool_result");
    expect(retained).toHaveLength(1); expect(retained[0].hydrogenTool).toEqual(pendingB!.hydrogenTool);
    const content = serverToolResponseContent(second.history, serverToolParts(collectServerToolCalls(second.history, second.serverTools), "openai_responses"), secondRequest.messages.length);
    const projected = buildResponse("openai_responses", { ...second.value.response.data(), content }).renderSelf("svc");
    expect((projected.output as Array<Record<string, unknown>>).map(item => item.type)).toEqual(["web_search_call", "message"]);
    expect(JSON.stringify(projected)).toContain("answer B"); expect(JSON.stringify(projected)).not.toContain("answer A");
    for (const privateField of ["hydrogenTool", "instanceId", "hostedToolReceipts", f.nameA]) expect(JSON.stringify(projected)).not.toContain(privateField);
    const third = await runHostedTools(f.agent, buildRequest("openai_responses", { ...seed([]).data(), stream,
      messages: [...second.history, { role: "user", content: [{ type: "text", text: "next turn" }] }] }), [], f.deps.transport, options);
    expect(third.value.response.text()).toBe("answer B"); expect(f.adapters).toHaveLength(2); expect(third.receipts).toHaveLength(0);
    expect(third.traces.some(event => event.type === "hydrogen.tool.started")).toBe(false);
  });

  it("retains a later stage's actual receipt when output selects the earlier stage", async () => {
    const f = nestedReceiptGraph({ output: "first" });
    const entry = prepareServerTools(seed(), { tools: [f.b] }).matched.get(f.nameB)!;
    const call: ToolUsePart = { type: "tool_use", id: f.callId, name: f.nameB, input: { q: "B" } };
    markLocalToolCall(call, entry);
    const request = buildRequest("openai_responses", { ...seed([]).data(), messages: [{ role: "assistant", content: [call] }, { role: "user", content: [{ type: "text", text: "continue" }] }] });
    const run = await runHostedTools(f.agent, request, [], f.deps.transport, { sessionId: "s", config: HostedToolOptionsSchema.parse({ maxRounds: 1 }) });
    expect(run.value.response.text()).toBe("answer A"); expect(f.adapters.map(adapter => adapter.url)).toEqual(["https://adapter.test/B"]);
    expect(run.history.flatMap(message => message.content)).toContainEqual(expect.objectContaining({ type: "tool_result", toolUseId: f.callId, hydrogenTool: call.hydrogenTool }));
    expect(run.serverTools.get(f.nameB)?.tool.id).toBe(f.b.id); expect(run.receipts).toHaveLength(1);
  });

  it.each([false, true])("resumes only the unanswered reused provider ID (same executor=%s)", async sameExecutor => {
    const f = fixture({ answer: () => [{ type: "text", text: "done" }] });
    const b = tool(), a = sameExecutor ? b : tool({ id: 43, name: "lookup_A", url: "https://adapter.test/A", serverTool: { name: "web_fetch", resultType: "web_fetch_result", resultPath: "/results" } });
    const entryA = prepareServerTools(seed([{ type: a.serverTool!.name }]), { tools: [a] }).matched.values().next().value!;
    const entryB = prepareServerTools(seed(), { tools: [b] }).matched.values().next().value!;
    const callA: ToolUsePart = { type: "tool_use", id: "reused", name: entryA.emittedName, input: { q: "same input" } };
    const callB: ToolUsePart = { type: "tool_use", id: "reused", name: entryB.emittedName, input: { q: "same input" } };
    markLocalToolCall(callA, entryA); markLocalToolCall(callB, entryB);
    expect(callA.hydrogenTool!.instanceId).not.toBe(callB.hydrogenTool!.instanceId);
    const completedA: ToolResultPart = { type: "tool_result", toolUseId: "reused", content: [{ type: "text", text: '{"results":[{"url":"https://old.test/"}]}' }], hydrogenTool: structuredClone(callA.hydrogenTool) };
    const messages: Message[] = [{ role: "assistant", content: [callA] }, { role: "user", content: [completedA] }, { role: "assistant", content: [callB] }];
    const bound = sameExecutor ? [b] : [a, b];
    const run = await runHostedTools(f.service(), buildRequest("openai_responses", { ...seed([]).data(), messages }), bound, f.deps.transport, { sessionId: "s" });
    expect(f.adapters.map(adapter => adapter.url)).toEqual([b.url]);
    const results = run.history.flatMap(message => message.content).filter((part): part is ToolResultPart => part.type === "tool_result");
    expect(results.map(result => result.hydrogenTool!.instanceId)).toEqual([callA.hydrogenTool!.instanceId, callB.hydrogenTool!.instanceId]);
    expect(collectServerToolCalls(run.history, run.serverTools).map(call => call.payload)).toEqual([{ results: [{ url: "https://old.test/" }] }, { results: [{ url: "https://example.test/", title: "fixture" }] }]);
    await runHostedTools(f.service(), buildRequest("openai_responses", { ...seed([]).data(), messages: run.history }), bound, f.deps.transport, { sessionId: "s" });
    expect(f.adapters).toHaveLength(1);
  });

  it("a receipt for another private instance cannot complete a retained call", () => {
    const entry = prepareServerTools(seed(), { tools: [tool()] }).matched.get(emitted)!;
    const oldCall: ToolUsePart = { type: "tool_use", id: "provider_local", name: emitted, input: { q: "same" } };
    const otherCall: ToolUsePart = { ...oldCall };
    markLocalToolCall(oldCall, entry); markLocalToolCall(otherCall, entry);
    const receipt = (call: ToolUsePart): HostedToolReceipt => ({ call, entry, result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: "[]" }], hydrogenTool: structuredClone(call.hydrogenTool) } });
    const history: Message[] = [{ role: "assistant", content: [oldCall] }];
    expect(retainServerToolReceipts(history, [receipt(otherCall)])).toEqual([]); expect(history).toHaveLength(1);
    expect(retainServerToolReceipts(history, [receipt(oldCall)])).toHaveLength(1); expect(history).toHaveLength(2);
    expect(retainServerToolReceipts(history, [receipt(oldCall)])).toEqual([]); expect(history).toHaveLength(2);
    expect(retainServerToolReceipts([], [receipt(oldCall)])).toEqual([]);
  });
});

describe("declared local ownership and names", () => {
  const lengthCases: Array<{ family: Family; prefix?: string; size: number; allowed: boolean }> = [
    ...(["openai_completion", "openai_responses"] as Family[]).flatMap(family => [
      { family, size: 42, allowed: true }, { family, size: 43, allowed: true }, { family, size: 44, allowed: false },
      { family, prefix: "", size: 64, allowed: true }, { family, prefix: "x".repeat(62), size: 1, allowed: true },
      { family, prefix: "x".repeat(63), size: 1, allowed: true }, { family, prefix: "x".repeat(64), size: 1, allowed: false },
    ]),
    { family: "anthropic", size: 64, allowed: true }, { family: "anthropic", prefix: "x".repeat(64), size: 63, allowed: true },
    { family: "anthropic", prefix: "x".repeat(64), size: 64, allowed: true }, { family: "anthropic", prefix: "x".repeat(64), size: 65, allowed: false },
  ];
  it.each(lengthCases)("validates combined emitted length ($family, prefix=$prefix, name=$size, allowed=$allowed)", async ({ family, prefix, size, allowed }) => {
    const f = fixture({ family, prefix });
    const inv = await f.service().invoke(seed(), undefined, { serverTools: { tools: [tool({ name: "n".repeat(size) })], prefix } });
    expect(inv.result.ok).toBe(allowed);
    expect(f.requests).toHaveLength(allowed ? 1 : 0); expect(f.adapters).toHaveLength(0);
    if (!allowed) {
      expect(inv.result).toMatchObject({ status: 400, errorBody: { error: { type: "invalid_request_error", code: null } } });
    }
  });
  it.each([undefined, "", "custom_"])("uses prefix %s and maps the exact executor ID", async prefix => {
    const f = fixture({ prefix });
    const run = await runHostedTools(f.service(), seed(), [tool()], f.deps.transport, { sessionId: "s" });
    const name = (prefix ?? "provider_server_side_") + "lookup";
    expect((f.requests[0].body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "function", name });
    expect(run.serverTools.get(name)?.tool.id).toBe(42);
    expect(run.history[1].content[0]).toMatchObject({ id: "call_1", name, hydrogenTool: { id: 42, emittedName: name, declaredName: "web_search" } });
    expect(f.adapters).toHaveLength(1);
    expect(f.adapters[0].body).toEqual({ q: "hello" });
  });
  it.each(["lookup", "web_search", emitted])("ordinary %s stays client-owned", async name => {
    const f = fixture({ answer: () => [{ type: "tool_use", id: "client", name, input: { q: "hello" } }] });
    const run = await runHostedTools(f.service(), seed([{ type: "function", name, parameters: { type: "object" } }]), [tool()], f.deps.transport, { sessionId: "s" });
    expect(run.value.response.toolCalls()[0].name).toBe(name);
    expect(run.serverTools.size).toBe(0);
    expect(f.adapters).toHaveLength(0);
  });
  it("does not grant a hallucinated prefix or stored name local ownership", async () => {
    for (const name of ["lookup", "provider_server_side_missing"]) {
      const f = fixture({ answer: () => [{ type: "tool_use", id: "unoffered", name, input: { q: "hello" } }] });
      const run = await runHostedTools(f.service(), seed(), [tool()], f.deps.transport, { sessionId: "s" });
      expect(run.value.response.toolCalls()[0].name).toBe(name);
      expect(f.adapters).toHaveLength(0);
    }
  });
  it("bindings alone expose no tools and cannot execute a guessed emitted call", async () => {
    const f = fixture({ answer: () => [{ type: "tool_use", id: "unoffered", name: emitted, input: { q: "hello" } }] });
    const run = await runHostedTools(f.service(), seed([]), [tool()], f.deps.transport, { sessionId: "s" });
    expect(f.requests[0].body.tools).toBeUndefined();
    expect(run.serverTools.size).toBe(0);
    expect(f.adapters).toHaveLength(0);
  });
  it.each(["aliases", "emitted", "bound names"])("rejects duplicate %s before any dispatch", async collision => {
    const f = fixture();
    const bound = collision === "aliases" ? [tool(), tool({ id: 43, name: "other" })]
      : collision === "bound names" ? [tool(), tool({ id: 43, serverTool: { name: "web_fetch", resultType: "web_fetch_result", resultPath: "" } })] : [tool()];
    const request = collision === "emitted" ? seed([raw, { type: "function", name: emitted, parameters: { type: "object" } }])
      : collision === "bound names" ? seed([raw, { type: "web_fetch" }]) : seed([]);
    await expect(runHostedTools(f.service(), request, bound, f.deps.transport, { sessionId: "s" })).rejects.toMatchObject({
      statusCode: 400, errorBody: { error: { code: "hydrogen_tool_name_conflict" } },
    });
    expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0);
  });
});

describe("policy decision table and exact declared names", () => {
  for (const mode of ["blacklist", "whitelist"] as const) for (const listed of [false, true]) for (const local of [false, true]) {
    it(`${mode}, listed=${listed}, local=${local}`, async () => {
      const f = fixture(), policy: ServerToolPolicy = { mode, names: listed ? ["web_search"] : [] };
      const bypass = mode === "whitelist" && listed;
      const execute = !bypass && local;
      const allowed = execute || (mode === "whitelist" ? listed : !listed);
      const service = f.service(definition({ serverToolPolicy: policy }));
      if (!allowed) {
        await expect(runHostedTools(service, seed(), local ? [tool()] : [], f.deps.transport, { sessionId: "s" })).rejects.toMatchObject({
          statusCode: 400, errorBody: { error: { type: "invalid_request_error", code: "tool_not_found" } },
        });
        expect(f.requests).toHaveLength(0);
      } else {
        const run = await runHostedTools(service, seed(), local ? [tool()] : [], f.deps.transport, { sessionId: "s" });
        expect(f.requests[0].body.tools).toEqual(execute ? [expect.objectContaining({ type: "function", name: emitted })] : [raw]);
        expect(run.serverTools.size).toBe(execute ? 1 : 0);
        expect(f.requests).toHaveLength(execute ? 2 : 1);
      }
      expect(f.adapters).toHaveLength(execute ? 1 : 0);
    });
  }
  it.each(["web_search", "web_search_preview", "web_search_preview_2025_03_11", "web_search_2025_08_26"])("uses the explicit plain name for Responses %s", type => {
    const prepared = prepareServerTools(seed([{ type }]), { tools: [tool()] }, { mode: "whitelist", names: ["web_search"] });
    expect(prepared.matched.size).toBe(0); expect(prepared.request.tools![0].raw?.value).toEqual({ type });
  });
  it("uses Anthropic's explicit name, and never heuristically strips an unknown type", () => {
    const declaration = { type: "web_search_20250305", name: "search_alias" };
    const prepared = prepareServerTools(seed([declaration], "anthropic"), { tools: [tool()] }, { mode: "whitelist", names: ["search_alias"] });
    expect(prepared.request.tools![0].raw?.value).toEqual(declaration);
    expect(() => prepareServerTools(seed([{ type: "vendor_tool_20251001" }]), { tools: [tool({ serverTool: { name: "vendor_tool", resultType: "result", resultPath: "" } })] }, { mode: "whitelist", names: ["vendor_tool"] }))
      .toThrow("Tool 'vendor_tool_20251001' not found");
  });
  it("replaces the whole inherited policy with an explicit empty list", async () => {
    const f = fixture();
    const service = f.service(definition({ serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] },
      steps: [{ model: "m", provider: "p", serverToolPolicy: { mode: "blacklist", names: [] } }] }));
    const result = await service.invoke(seed([{ type: "web_fetch" }]));
    expect(result.result.ok).toBe(true); expect(f.requests).toHaveLength(1);
    const local = f.service(definition({ serverToolPolicy: { mode: "whitelist", names: ["web_search"] },
      steps: [{ model: "m", provider: "p", serverToolPolicy: { mode: "whitelist", names: [] } }] }));
    await runHostedTools(local, seed(), [tool()], f.deps.transport, { sessionId: "s" });
    expect(f.adapters).toHaveLength(1);
  });
  it("uses the winning fallback map, while leaving a never-used restrictive fallback alone", async () => {
    const f = fixture({ fail: ["primary"] });
    const service = f.service(definition({ steps: [
      { model: "m", provider: "primary", retry: { maxAttempts: 1 }, serverToolPolicy: { mode: "whitelist", names: ["web_search"] } },
      { model: "m", provider: "fallback", retry: { maxAttempts: 1 }, serverToolPolicy: { mode: "blacklist", names: [] } },
    ] }));
    const run = await runHostedTools(service, seed(), [tool()], f.deps.transport, { sessionId: "s" });
    expect(f.requests.map(request => request.provider)).toEqual(["primary", "fallback", "primary", "fallback"]);
    expect((f.requests[0].body.tools as unknown[])[0]).toEqual(raw);
    expect(f.adapters).toHaveLength(1); expect(run.serverTools.get(emitted)?.tool.id).toBe(42);
    const continuation = f.requests[3].body.input as Array<Record<string, unknown>>;
    expect(continuation.find(item => item.type === "function_call")).toMatchObject({ name: emitted, call_id: "call_1" });
    expect(continuation.find(item => item.type === "function_call_output")).toMatchObject({ call_id: "call_1" });
    const unused = fixture();
    const ok = await unused.service(definition({ steps: [{ model: "m", provider: "primary" },
      { model: "m", provider: "fallback", serverToolPolicy: { mode: "whitelist", names: [] } }] })).invoke(seed([{ type: "web_fetch" }]));
    expect(ok.result.ok).toBe(true); expect(unused.requests).toHaveLength(1);
  });
  it.each([false, true])("policy denial is terminal; prior failure=%s is counted separately", async prior => {
    const f = fixture({ fail: prior ? ["primary"] : [] });
    const steps = [...(prior ? [{ model: "m", provider: "primary", retry: { maxAttempts: 1 } }] : []),
      { model: "m", provider: "blocked", retry: { maxAttempts: 3, on: ["error"] }, serverToolPolicy: { mode: "whitelist", names: [] } },
      { model: "m", provider: "permissive" }];
    const inv = await f.service(definition({ steps } as Partial<ServiceSteps>)).invoke(seed([{ type: "web_fetch" }]));
    expect(inv.result).toMatchObject({ ok: false, status: 400, terminal: true, errorBody: { error: { code: "tool_not_found" } } });
    expect(f.requests.map(request => request.provider)).toEqual(prior ? ["primary"] : []);
  });
});

describe("effective overlays and forced choices", () => {
  it.each(["web_search", "web_search_preview"])("Responses %s cannot hide its native plain name in an extra name field", async type => {
    const declaration = { type, name: "neutral" };
    const blocked = fixture();
    const inv = await blocked.service(definition({ serverToolPolicy: { mode: "blacklist", names: ["web_search"] } })).invoke(seed([declaration]));
    expect(inv.result).toMatchObject({ ok: false, status: 400, errorBody: { error: { code: "tool_not_found" } } });
    expect(blocked.requests).toHaveLength(0); expect(blocked.adapters).toHaveLength(0);
    const local = fixture();
    await runHostedTools(local.service(), seed([declaration]).withOverrides({ extra: { tool_choice: { type, name: "neutral" } } }), [tool()], local.deps.transport, { sessionId: "s" });
    expect(local.requests[0].body.tool_choice).toEqual({ type: "function", name: emitted }); expect(local.adapters).toHaveLength(1);
  });
  it.each(["extra", "passthrough"])("policy cannot be bypassed with %s tools", async source => {
    const f = fixture();
    const params = source === "extra" ? { extra: { tools: [{ type: "web_fetch" }] } }
      : { passthrough: { family: "openai_responses" as const, params: { tools: [{ type: "web_fetch" }] } } };
    const request = buildRequest("openai_responses", { ...seed([]).data(), params });
    const inv = await f.service(definition({ serverToolPolicy: { mode: "whitelist", names: [] } })).invoke(request);
    expect(inv.result).toMatchObject({ ok: false, status: 400 }); expect(f.requests).toHaveLength(0);
  });
  it.each(["extra", "passthrough"])("completion raw %s tools obey policy while allowed extensions pass unchanged", async source => {
    const declaration = { type: "web_fetch", name: "fetch_exact", extension_option: "retained" };
    const params = source === "extra" ? { extra: { tools: [declaration] } }
      : { passthrough: { family: "openai_completion" as const, params: { tools: [declaration] } } };
    const request = buildRequest("openai_completion", { ...seed([], "openai_completion").data(), params });
    for (const policy of [{ mode: "blacklist", names: ["fetch_exact"] }, { mode: "whitelist", names: [] }] as ServerToolPolicy[]) {
      const blocked = fixture({ family: "openai_completion" });
      const inv = await blocked.service(definition({ serverToolPolicy: policy })).invoke(request);
      expect(inv.result).toMatchObject({ ok: false, status: 400, errorBody: { error: { code: "tool_not_found" } } });
      expect(blocked.requests).toHaveLength(0); expect(blocked.adapters).toHaveLength(0);
    }
    const allowed = fixture({ family: "openai_completion" });
    const inv = await allowed.service().invoke(request);
    expect(inv.result.ok).toBe(true); expect(allowed.requests[0].body.tools).toEqual([declaration]); expect(allowed.adapters).toHaveLength(0);
  });
  it("an overlay replacing the server declaration with a function never gains ownership", async () => {
    const f = fixture();
    const request = seed().withOverrides({ extra: { tools: [{ type: "function", name: emitted, parameters: { type: "object" } }], tool_choice: { type: "function", name: emitted } } });
    const run = await runHostedTools(f.service(), request, [tool()], f.deps.transport, { sessionId: "s" });
    expect(run.serverTools.size).toBe(0); expect(f.adapters).toHaveLength(0);
    expect(run.value.response.toolCalls()[0].name).toBe(emitted);
  });
  it("rewrites overlay declarations and releases their forced choice after one round", async () => {
    const f = fixture();
    const service = f.service(definition({ steps: [{ model: "m", provider: "p", overrides: { extra: { tools: [raw], tool_choice: { type: "web_search" } } } }] }));
    await runHostedTools(service, seed([]), [tool()], f.deps.transport, { sessionId: "s" });
    expect(f.requests[0].body.tool_choice).toEqual({ type: "function", name: emitted });
    expect(f.requests[1].body.tool_choice).toBe("auto"); expect(f.adapters).toHaveLength(1);
  });
  it("allowed_tools preserves an explicitly selected same-named client function", async () => {
    const f = fixture({ answer: () => [{ type: "tool_use", id: "client", name: "web_search", input: {} }] });
    const request = seed([raw, { type: "function", name: "web_search", parameters: { type: "object" } }]).withOverrides({
      extra: { tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "web_search" }] } },
    });
    const run = await runHostedTools(f.service(), request, [tool()], f.deps.transport, { sessionId: "s" });
    expect(f.requests[0].body.tool_choice).toEqual({ type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "web_search" }] });
    expect(run.value.response.toolCalls()[0].name).toBe("web_search"); expect(f.adapters).toHaveLength(0);
  });
  it.each(["openai_responses", "openai_completion"] as Family[])("%s preserves an explicitly selected same-named client custom tool", async family => {
    const f = fixture({ family, answer: () => [{ type: "tool_use", id: "client", name: "web_search", input: {} }] });
    const custom = family === "openai_completion" ? { type: "custom", custom: { name: "web_search", format: { type: "text" } } }
      : { type: "custom", name: "web_search", format: { type: "text" } };
    const selection = family === "openai_completion" ? { type: "custom", custom: { name: "web_search" } } : { type: "custom", name: "web_search" };
    const request = seed([raw, custom], family).withOverrides({ extra: { tool_choice: selection } });
    const run = await runHostedTools(f.service(), request, [tool()], f.deps.transport, { sessionId: "s" });
    expect(f.requests[0].body.tool_choice).toEqual(selection);
    expect(f.requests[0].body.tools).toContainEqual(custom);
    expect(run.value.response.toolCalls()[0].name).toBe("web_search"); expect(f.adapters).toHaveLength(0);
  });
  it.each(["function", "custom"])("native bypass cannot satisfy a missing %s selection", async type => {
    for (const selection of [{ type, name: "web_search" }, { type: "allowed_tools", mode: "required", tools: [{ type, name: "web_search" }] }]) {
      const f = fixture();
      const request = seed().withOverrides({ extra: { tool_choice: selection } });
      const inv = await f.service(definition({ serverToolPolicy: { mode: "whitelist", names: ["web_search"] } })).invoke(request, undefined, { serverTools: { tools: [tool()] } });
      expect(inv.result).toMatchObject({ ok: false, status: 400, errorBody: { error: { code: "tool_not_found" } } });
      expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0);
    }
  });
  it("validates nested completion allowed_tools references without taking over client functions", async () => {
    const f = fixture({ family: "openai_completion", answer: () => [{ type: "tool_use", id: "client", name: "web_search", input: {} }] });
    const selection = { type: "allowed_tools", allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "web_search" } }] } };
    const request = seed([raw, { type: "function", function: { name: "web_search", parameters: { type: "object" } } }], "openai_completion").withOverrides({ extra: { tool_choice: selection } });
    await runHostedTools(f.service(), request, [tool()], f.deps.transport, { sessionId: "s" });
    expect(f.requests[0].body.tool_choice).toEqual(selection); expect(f.adapters).toHaveLength(0);
    const missing = fixture({ family: "openai_completion" });
    const inv = await missing.service(definition({ serverToolPolicy: { mode: "whitelist", names: ["web_search"] } })).invoke(seed([raw], "openai_completion").withOverrides({ extra: { tool_choice: selection } }));
    expect(inv.result).toMatchObject({ ok: false, status: 400 }); expect(missing.requests).toHaveLength(0);
  });
  it("rewrites a native server reference inside allowed_tools, and validates missing selections", async () => {
    const f = fixture();
    await runHostedTools(f.service(), seed().withOverrides({ extra: { tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "web_search" }] } } }), [tool()], f.deps.transport, { sessionId: "s" });
    expect(f.requests[0].body.tool_choice).toEqual({ type: "allowed_tools", mode: "required", tools: [{ type: "function", name: emitted }] });
    const invalid = fixture();
    const inv = await invalid.service().invoke(seed([]).withOverrides({ extra: { tool_choice: { type: "function", name: emitted } } }));
    expect(inv.result).toMatchObject({ ok: false, status: 400, errorBody: { error: { code: "tool_not_found" } } });
    expect(invalid.requests).toHaveLength(0);
  });
  it("checks the effective none choice before adapter dispatch", async () => {
    const f = fixture();
    await expect(runHostedTools(f.service(), seed().withOverrides({ extra: { tool_choice: "none" } }), [tool()], f.deps.transport, { sessionId: "s" })).rejects.toThrow("tool_choice:none");
    expect(f.requests).toHaveLength(1); expect(f.adapters).toHaveLength(0);
  });
});

describe("streaming, nested services and protocol boundaries", () => {
  it("uses the same emitted map/call IDs through real stream parsing and continuation", async () => {
    const f = fixture(), events: unknown[] = [];
    const run = await runHostedTools(f.service(), seed().withStream(true), [tool()], f.deps.transport,
      { sessionId: "s", config: HostedToolOptionsSchema.parse({ streamMode: "all" }), emit: async event => { events.push(event); } });
    expect(f.requests.every(request => request.stream)).toBe(true);
    expect(f.adapters).toHaveLength(1); expect(run.value.response.text()).toBe("done");
    expect(run.history[1].content[0]).toMatchObject({ id: "call_1", name: emitted, hydrogenTool: { id: 42 } });
    expect(JSON.stringify(events)).toContain('"model_call_id":"call_1"');
  });
  it("an allowed unmatched raw declaration cannot silently cross families", async () => {
    const f = fixture({ family: "openai_completion" });
    const inv = await f.service().invoke(seed());
    expect(inv.result).toMatchObject({ ok: false, status: 400, message: expect.stringContaining("cannot be sent to openai_completion") });
    expect(f.requests).toHaveLength(0);
    const local = await runHostedTools(f.service(), seed([{ type: "web_search_20250305", name: "web_search" }], "anthropic"), [tool()], f.deps.transport, { sessionId: "s" });
    expect(local.value.response.text()).toBe("done"); expect(f.adapters).toHaveLength(1);
  });
  it("keeps a same-family whitelist native choice untouched", async () => {
    const f = fixture();
    const request = parseRequest("openai_responses", { model: "svc", input: "q", tools: [raw], tool_choice: { type: "web_search" } });
    await runHostedTools(f.service(definition({ serverToolPolicy: { mode: "whitelist", names: ["web_search"] } })), request, [tool()], f.deps.transport, { sessionId: "s" });
    expect(f.requests[0].body.tool_choice).toEqual({ type: "web_search" }); expect(f.adapters).toHaveLength(0);
  });
  it("preserves Anthropic forced native selection for a whitelist bypass", async () => {
    const f = fixture({ family: "anthropic" });
    const request = seed([{ type: "web_search_20250305", name: "web_search" }], "anthropic").withOverrides({ extra: { tool_choice: { type: "tool", name: "web_search" } } });
    const inv = await f.service(definition({ serverToolPolicy: { mode: "whitelist", names: ["web_search"] } })).invoke(request, undefined, { serverTools: { tools: [tool()] } });
    expect(inv.result.ok).toBe(true); expect(f.requests[0].body.tool_choice).toEqual({ type: "tool", name: "web_search" }); expect(f.adapters).toHaveLength(0);
  });
  it("nested HostedToolService obeys its Model Service step policy and exposes no undeclared binding", async () => {
    const f = fixture();
    const nested = new HostedToolService(f.service(definition({ serverToolPolicy: { mode: "whitelist", names: ["web_search"] },
      steps: [{ model: "m", provider: "p", serverToolPolicy: { mode: "whitelist", names: [] } }] })), f.deps, [tool()]);
    const inv = await nested.invoke(seed());
    expect(inv.result.ok).toBe(true); expect(f.adapters).toHaveLength(1);
    const noDeclaration = await nested.invoke(seed([]));
    expect(noDeclaration.result.ok).toBe(true); expect(f.requests.at(-1)!.body.tools).toBeUndefined();
    expect(f.adapters).toHaveLength(1);
  });
  it("preflights the router-selected stage before any OCR or provider side effect", async () => {
    const f = fixture(), blocked = f.service(definition({ serverToolPolicy: { mode: "whitelist", names: [] } }));
    const agent = new MicroAgent(parseService({ kind: "micro_agent", ocr: { service: "ocr" }, stages: [
      { name: "route", input: [], transitions: [{ when: { type: "input_contains", value: "q" }, goto: "blocked" }] },
      { name: "skip", service: "permissive", input: [] }, { name: "blocked", service: "blocked", input: [] },
    ] }) as AgentDef, { ...f.deps, logMaxChars: 1000, resolver: { sttDef: () => ({ ok: false, message: "unused" }), resolve: name => ({ ok: true, executor: name === "blocked" ? blocked : f.service(), isAgent: false }) } });
    const request = buildRequest(seed().family, { ...seed([{ type: "web_fetch" }]).data(), messages: [{ role: "user", content: [{ type: "text", text: "q" }, { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA==" } }] }] });
    const inv = await agent.invoke(request);
    expect(inv.result).toMatchObject({ ok: false, status: 400, errorBody: { error: { code: "tool_not_found" } } });
    expect(f.requests).toHaveLength(0); expect(f.adapters).toHaveLength(0);
  });
  it("local rejection keeps the native Anthropic error envelope", () => {
    try { prepareServerTools(seed([{ type: "web_fetch_20250910", name: "web_fetch" }], "anthropic"), { tools: [] }, { mode: "whitelist", names: [] }); throw new Error("expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(ServerToolPreflightError);
      expect(error).toMatchObject({ errorBody: { type: "error", error: { type: "invalid_request_error", message: "Tool 'web_fetch' not found" } } });
      expect((error as ServerToolPreflightError).errorBody.error).not.toHaveProperty("code");
    }
  });
});
