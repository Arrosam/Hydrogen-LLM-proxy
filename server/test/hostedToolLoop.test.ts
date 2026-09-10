import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import "../src/core/format";
import { buildRequest, buildResponse } from "../src/core/format/registry";
import { fabricateStream } from "../src/core/ir/stream";
import type { ContentPart } from "../src/core/ir/content";
import type { Request } from "../src/core/ir/request";
import type { Invocation } from "../src/execution/outcome";
import { runHostedTools } from "../src/execution/hostedToolLoop";
import { HttpToolSchema } from "../src/execution/toolHttp";
import { HostedToolOptionsSchema } from "../src/execution/definition";
import { parseService, type AgentDef } from "../src/execution/definition";
import { HostedToolService } from "../src/execution/hostedToolService";
import { MicroAgent } from "../src/execution/microAgent";
import type { ModelService, ServiceDeps } from "../src/execution/modelService";

const tool = HttpToolSchema.parse({ name: "lookup", parameters: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false }, url: "https://adapter.test/run", bodyTemplate: { count: "{{arguments.count}}" }, resultPath: "/result" });
const request = buildRequest("openai_responses", { requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "lookup" }] }], params: {}, stream: false });
const call: ContentPart = { type: "tool_use", id: "c1", name: "lookup", input: { count: 3 } };
function executor(outputs: ContentPart[][]) {
  const requests: Request[] = [];
  const invoke = vi.fn(async (req: Request): Promise<Invocation> => {
    requests.push(req);
    const content = outputs.shift() ?? [{ type: "text", text: "done" }];
    return { attempts: 1, attemptPath: [], result: { ok: true, value: { family: "openai_responses", modelName: "m", providerName: "p", upstreamModel: "up", upstreamRequest: {},
      response: buildResponse("openai_responses", { id: "up", model: "up", created: 1, content, stopReason: content.some(p => p.type === "tool_use") ? "tool_use" : "stop", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }) } } };
  });
  return { requests, invoke, stream: vi.fn(async (req: Request) => {
    const result = (await invoke(req)).result;
    if (!result.ok) throw new Error("fixture");
    return { attempts: 1, attemptPath: [], result: { ok: true as const, value: { ...result.value, dropReasoning: false, events: fabricateStream(result.value.response.data(), Infinity) } } };
  }) };
}
const transport = () => ({ postStream: vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from(['{"result":{"answer":3}}']) })) });

describe("hosted model/tool loop", () => {
  it("hides thinking in process events while keeping the original for tool continuation", async () => {
    const e = executor([[{ type: "reasoning", text: "private trace", signature: "sig", origin: "anthropic" }, call]]);
    const events: unknown[] = [];
    await runHostedTools(e, request, [tool], transport(), { sessionId: "s", config: HostedToolOptionsSchema.parse({ streamMode: "all" }), thinkingFormat: "none", emit: async e => { events.push(e); } });
    expect(JSON.stringify(events)).not.toContain("private trace");
    expect(JSON.stringify(e.requests[1].messages)).toContain("private trace");
  });
  it("runs bound tools inside a Micro Agent stage and shares the parent's call budget", async () => {
    const e = executor([[call], [{ ...call, id: "c2" }]]), t = transport();
    const deps = { transport: t, catalog: {} } as unknown as ServiceDeps;
    const child = new HostedToolService(e as unknown as ModelService, deps, [tool]);
    const agent = new MicroAgent(parseService({ kind: "micro_agent", stages: [{ name: "stage", service: "child", input: [] }] }) as AgentDef,
      { ...deps, logMaxChars: 10000, resolver: { resolve: () => ({ ok: true, executor: child, isAgent: false }) } });
    const run = await runHostedTools(agent, request, [tool], t, { sessionId: "shared", config: HostedToolOptionsSchema.parse({ maxCalls: 1 }) });
    expect(run.value.response.text()).toBe("done");
    expect(run.value.response.usage.totalTokens).toBe(15);
    expect(t.postStream).toHaveBeenCalledTimes(1);
    expect(run.traces.filter(e => e.type === "hydrogen.tool.completed").at(-1)).toMatchObject({ isError: true });
    expect(run.calls[0].calls?.length).toBe(1);
  });
  it("retains consumed model usage when cancellation interrupts an HTTP tool", async () => {
    const abort = new AbortController();
    const e = executor([[call]]);
    const t = { postStream: vi.fn(async () => { abort.abort(); abort.signal.throwIfAborted(); throw new Error("unreachable"); }) };
    try { await runHostedTools(e, request, [tool], t, { sessionId: "s", signal: abort.signal }); throw new Error("expected cancellation"); }
    catch (error) { expect(error).toMatchObject({ statusCode: 499, usage: { totalTokens: 5 } }); }
  });
  it("injects definitions, executes POST, replays results and sums model usage", async () => {
    const e = executor([[call]]), t = transport();
    const run = await runHostedTools(e, request, [tool], t, { sessionId: "session" });
    expect(t.postStream).toHaveBeenCalledTimes(1);
    expect(e.requests[0].tools?.[0].name).toBe("lookup");
    expect(e.requests[1].messages.at(-1)?.content[0]).toMatchObject({ type: "tool_result", toolUseId: "c1", isError: false });
    expect(run.value.response.usage.totalTokens).toBe(10);
    expect(run.value.response.toolCalls()).toEqual([]);
    expect(run.history).toHaveLength(4);
  });
  it("returns invalid arguments to the model without calling the adapter", async () => {
    const e = executor([[{ ...call, input: { count: "bad" } }]]), t = transport();
    const run = await runHostedTools(e, request, [tool], t, { sessionId: "s" });
    expect(t.postStream).not.toHaveBeenCalled();
    expect(run.traces.at(-1)).toMatchObject({ isError: true });
    expect(e.requests[1].messages.at(-1)?.content[0]).toMatchObject({ isError: true });
  });
  it("finishes hosted tools then returns only client calls with complete saved history", async () => {
    const e = executor([[call, { type: "tool_use", id: "client", name: "local", input: {} }]]);
    const run = await runHostedTools(e, request, [tool], transport(), { sessionId: "s" });
    expect(e.invoke).toHaveBeenCalledTimes(1);
    expect(run.value.response.toolCalls().map(c => c.id)).toEqual(["client"]);
    expect(run.history.at(-1)?.content[0]).toMatchObject({ toolUseId: "c1" });
  });
  it.each(["all", "progress", "final"] as const)("honors %s delivery without leaking hosted calls as client calls", async streamMode => {
    const e = executor([[call]]), events: string[] = [];
    const run = await runHostedTools(e, request, [tool], transport(), { sessionId: "s", config: HostedToolOptionsSchema.parse({ streamMode }), emit: async event => { events.push(event.type); } });
    expect(events.includes("hydrogen.model.delta")).toBe(streamMode === "all");
    expect(events.includes("hydrogen.tool.started")).toBe(streamMode !== "final");
    expect(run.value.response.text()).toBe("done");
  });
  it("bounds rounds, refuses duplicate IDs, and rejects name collisions before model execution", async () => {
    const t = transport();
    await expect(runHostedTools(executor([[call], [call]]), request, [tool], t, { sessionId: "s" })).rejects.toThrow("repeated");
    expect(t.postStream).toHaveBeenCalledTimes(1);
    await expect(runHostedTools(executor([[call]]), request, [tool], transport(), { sessionId: "s", config: HostedToolOptionsSchema.parse({ maxRounds: 1 }) })).rejects.toThrow("round limit");
    const e = executor([]);
    await expect(runHostedTools(e, buildRequest(request.family, { ...request.data(), tools: [{ name: "lookup", parameters: {} }] }), [tool], t, { sessionId: "s" })).rejects.toThrow("conflicts");
    expect(e.invoke).not.toHaveBeenCalled();
  });
});
