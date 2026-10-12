/**
 * E5: HostedToolService.stream starts the pacing clock before the run and
 *     counts attempts recursively on failure, like the other two executors.
 * E6: a failed streamed model round is logged with the raw failure status,
 *     exactly as a buffered round is (the run's own error still maps it).
 * E9: a call the call budget refuses carries its own error code, so it is not
 *     mistaken for a call a pause left unexecuted.
 */
import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import "../src/core/format";
import { buildRequest, buildResponse } from "../src/core/format/registry";
import type { ContentPart } from "../src/core/ir/content";
import type { Request } from "../src/core/ir/request";
import type { Invocation, StreamInvocation } from "../src/execution/outcome";
import type { AttemptRecord } from "../src/execution/steps";
import { HostedRunError, runHostedTools } from "../src/execution/hostedToolLoop";
import { BUDGET_REFUSED_TOOL_CODE, HttpToolSchema, PAUSED_TOOL_MARKER } from "../src/execution/toolHttp";
import { HostedToolOptionsSchema } from "../src/execution/definition";
import { HostedToolService } from "../src/execution/hostedToolService";
import { collectServerToolCalls } from "../src/execution/serverTools";
import type { ModelService, ServiceDeps } from "../src/execution/modelService";

const tool = HttpToolSchema.parse({
  name: "lookup", parameters: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false },
  url: "https://adapter.test/run", bodyTemplate: { count: "{{arguments.count}}" }, resultPath: "/result", serverTool: { name: "web_search" },
});
const request = buildRequest("openai_responses", { requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "lookup" }] }], params: {}, stream: false });
const call: ContentPart = { type: "tool_use", id: "c1", name: "lookup", input: { count: 3 } };
const answer = (content: ContentPart[]): Invocation => ({
  attempts: 1, attemptPath: [],
  result: { ok: true, value: { family: "openai_responses", modelName: "m", providerName: "p", upstreamModel: "up", upstreamRequest: {},
    response: buildResponse("openai_responses", { id: "up", model: "up", created: 1, content, stopReason: content.some(p => p.type === "tool_use") ? "tool_use" : "stop", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }) } },
});
const transport = () => ({ postStream: vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from(['{"result":{"answer":3}}']) })) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("E5: HostedToolService", () => {
  it("stream: the run's own duration counts against the pacing budget", async () => {
    const RUN_MS = 300;
    // 80 chars is ~20 tokens: 200 ms of pacing at 100 tokens/s, less than the run took.
    const inner = { timeoutMs: 1000, invoke: async () => { await sleep(RUN_MS); return answer([{ type: "text", text: "x".repeat(80) }]); } };
    const deps = { transport: transport(), catalog: {}, simulatedStreamingTokenRate: 100 } as unknown as ServiceDeps;
    const svc = new HostedToolService(inner as unknown as ModelService, deps, [tool]);
    const inv = await svc.stream(request);
    if (!inv.result.ok) throw new Error("fixture");
    const started = Date.now();
    let text = "";
    for await (const event of inv.result.value.events) if (event.type === "text_delta") text += event.text;
    expect(text).toBe("x".repeat(80));
    // The budget was already spent while the run was in flight: nothing is left to wait for.
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("invoke: a failed run counts the attempts of nested calls too", async () => {
    const attempt = { step: 1, attempt: 1, model: "m", provider: "p", status: 429, kind: "http", latencyMs: 1 } as AttemptRecord;
    const nested = { stage: "inner", service: "x", kind: "service" as const, status: 429, latencyMs: 1, attempts: [attempt, { ...attempt, attempt: 2 }] };
    const inner = { timeoutMs: 1000, invoke: async (): Promise<Invocation> => ({ attempts: 2, attemptPath: [nested], result: { ok: false, status: 429, kind: "http", message: "slow down" } }) };
    const deps = { transport: transport(), catalog: {} } as unknown as ServiceDeps;
    const inv = await new HostedToolService(inner as unknown as ModelService, deps, [tool]).invoke(request);
    expect(inv.result).toMatchObject({ ok: false, status: 429, message: "slow down" });
    expect(inv.attempts).toBe(2);
  });
});

describe("E6: a failed model round's logged status", () => {
  const failed = { ok: false as const, status: 0, kind: "network" as const, message: "socket hang up" };
  const run = (streamed: boolean) => runHostedTools(
    {
      invoke: async (): Promise<Invocation> => ({ attempts: 1, attemptPath: [], result: failed }),
      stream: async (): Promise<StreamInvocation> => ({ attempts: 1, attemptPath: [], result: failed }),
    },
    request, [tool], transport(),
    { sessionId: "s", ...(streamed ? { onModelEvent: async () => {} } : {}) },
  ).catch((caught: unknown) => caught as HostedRunError);

  it("is the raw status on both paths, while the run fails with the mapped one", async () => {
    const buffered = await run(false) as HostedRunError;
    const streamed = await run(true) as HostedRunError;
    expect(buffered).toBeInstanceOf(HostedRunError);
    expect(streamed).toBeInstanceOf(HostedRunError);
    expect(buffered).toMatchObject({ statusCode: 502, message: "socket hang up" });
    expect(streamed).toMatchObject({ statusCode: 502, message: "socket hang up" });
    expect(buffered.calls.map((c) => c.status)).toEqual([0]);
    expect(streamed.calls.map((c) => c.status)).toEqual([0]);
    expect(streamed.calls[0]).toMatchObject({ streamed: true, error: "socket hang up" });
  });
});

describe("E9: a call the budget refused", () => {
  it("has its own code and is not flagged as left unexecuted by a pause", async () => {
    expect(BUDGET_REFUSED_TOOL_CODE).not.toBe(PAUSED_TOOL_MARKER);
    expect(PAUSED_TOOL_MARKER).toBe("tool_call_limit");

    const outputs: ContentPart[][] = [[call, { ...call, id: "c2" }], [{ type: "text", text: "answer" }]];
    const seen: Request[] = [];
    const invoke = async (req: Request): Promise<Invocation> => { seen.push(req); return answer(outputs.shift()!); };
    const t = transport();
    const result = await runHostedTools({ invoke, stream: async () => { throw new Error("unused"); } }, request, [tool], t, { sessionId: "s", config: HostedToolOptionsSchema.parse({ maxCalls: 1 }) });
    expect(result.paused).toBe(false);
    expect(t.postStream).toHaveBeenCalledTimes(1);

    // What the model is told about the refused call.
    const results = seen[1].messages.at(-1)!.content;
    expect(results[1]).toMatchObject({ type: "tool_result", toolUseId: "c2", isError: true });
    expect(JSON.parse((results[1] as { content: Array<{ text: string }> }).content[0].text)).toEqual({ error: { code: BUDGET_REFUSED_TOOL_CODE, message: "Hosted tool call budget exhausted" } });

    const calls = collectServerToolCalls(result.history, new Map([["lookup", { tool, declaration: { name: "web_search", type: "web_search" } }]]));
    expect(calls.map((c) => [c.id, c.isError, c.notExecuted])).toEqual([["c1", false, false], ["c2", true, false]]);
  });
});
