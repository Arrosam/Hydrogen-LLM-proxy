/**
 * Independent verification, written from the spec only (EXEC E5, E6, E9).
 *
 * E5  The hosted-tool streamed path counts attempts like the buffered path: on
 *     a failing run the attempt count includes the nested attempts.
 * E6  A failed streamed hosted-tool round logs the same status the buffered
 *     path logs for the same upstream failure.
 * E9  A tool call refused because the call budget is exhausted reports error
 *     code `tool_call_budget_exhausted`; a call declined because the loop
 *     paused keeps the pause marker `tool_call_limit`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import "../src/core/format";
import { buildRequest, buildResponse } from "../src/core/format/registry";
import { fabricateStream } from "../src/core/ir/stream";
import type { ContentPart, Message } from "../src/core/ir/content";
import type { Request } from "../src/core/ir/request";
import type { Invocation, StreamInvocation } from "../src/execution/outcome";
import { runHostedTools, type HostedEvent } from "../src/execution/hostedToolLoop";
import { BUDGET_REFUSED_TOOL_CODE, HttpToolSchema, PAUSED_TOOL_MARKER } from "../src/execution/toolHttp";
import { HostedToolOptionsSchema, parseService, type AgentDef } from "../src/execution/definition";
import { HostedToolService } from "../src/execution/hostedToolService";
import { MicroAgent } from "../src/execution/microAgent";
import type { ModelService, ServiceDeps } from "../src/execution/modelService";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

// ---------------------------------------------------------------------------
// E9 -- the loop itself, driven through its public entry point
// ---------------------------------------------------------------------------

const BUDGET_CODE = "tool_call_budget_exhausted";
const PAUSE_MARKER = "tool_call_limit";

const tool = HttpToolSchema.parse({
  name: "lookup",
  parameters: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false },
  url: "https://adapter.test/run",
  bodyTemplate: { count: "{{arguments.count}}" },
  resultPath: "/result",
});
const request = buildRequest("openai_responses", { requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "lookup" }] }], params: {}, stream: false });
const callPart = (id: string): ContentPart => ({ type: "tool_use", id, name: "lookup", input: { count: 3 } });

function executor(outputs: ContentPart[][]) {
  const requests: Request[] = [];
  const invoke = vi.fn(async (req: Request): Promise<Invocation> => {
    requests.push(req);
    const content = outputs.shift() ?? [{ type: "text", text: "done" }];
    return { attempts: 1, attemptPath: [], result: { ok: true, value: { family: "openai_responses", modelName: "m", providerName: "p", upstreamModel: "up", upstreamRequest: {},
      response: buildResponse("openai_responses", { id: "up", model: "up", created: 1, content, stopReason: content.some((p) => p.type === "tool_use") ? "tool_use" : "stop", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }) } } };
  });
  return { requests, invoke, stream: vi.fn(async (req: Request) => {
    const result = (await invoke(req)).result;
    if (!result.ok) throw new Error("fixture");
    return { attempts: 1, attemptPath: [], result: { ok: true as const, value: { ...result.value, dropReasoning: false, events: fabricateStream(result.value.response.data(), Infinity) } } };
  }) };
}
const adapter = () => ({ postStream: vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from(['{"result":{"answer":3}}']) })) });

/** Every tool result the model was shown for `toolUseId`, in the given messages. */
function resultsFor(messages: readonly Message[], toolUseId: string): Array<{ isError?: boolean; text: string }> {
  const out: Array<{ isError?: boolean; text: string }> = [];
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === "tool_result" && part.toolUseId === toolUseId) out.push({ isError: part.isError, text: JSON.stringify(part.content) });
    }
  }
  return out;
}
/** The error code inside a tool result's JSON text (`{"error":{"code":…}}`). */
function errorCode(result: { text: string }): unknown {
  const parts = JSON.parse(result.text) as Array<{ type: string; text?: string }>;
  const text = parts.find((p) => p.type === "text")?.text ?? "{}";
  return (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
}
const completed = (traces: HostedEvent[], modelCallId: string): HostedEvent[] =>
  traces.filter((t) => t.type === "hydrogen.tool.completed" && t.model_call_id === modelCallId);

describe("E9: the two refusals are told apart", () => {
  it("the published names carry the spec's values", () => {
    expect(BUDGET_REFUSED_TOOL_CODE).toBe(BUDGET_CODE);
    expect(PAUSED_TOOL_MARKER).toBe(PAUSE_MARKER);
  });

  it("per-round budget: the call past maxCalls is answered with tool_call_budget_exhausted", async () => {
    const e = executor([[callPart("c1"), callPart("c2")]]);
    const t = adapter();
    const run = await runHostedTools(e, request, [tool], t, { sessionId: "s", config: HostedToolOptionsSchema.parse({ maxCalls: 1 }) });

    expect(t.postStream).toHaveBeenCalledTimes(1);
    // The model is told, in the very next round, which call it may not make.
    const shown = resultsFor(e.requests[1].messages, "c2");
    expect(shown).toHaveLength(1);
    expect(shown[0].isError).toBe(true);
    expect(errorCode(shown[0])).toBe(BUDGET_CODE);
    expect(shown[0].text).not.toContain(PAUSE_MARKER);
    // The same in the saved history and in the trace.
    expect(errorCode(resultsFor(run.history, "c2")[0])).toBe(BUDGET_CODE);
    const trace = completed(run.traces, "c2");
    expect(trace).toHaveLength(1);
    expect(trace[0].isError).toBe(true);
    expect(JSON.stringify(trace[0])).toContain(BUDGET_CODE);
    expect(JSON.stringify(trace[0])).not.toContain(PAUSE_MARKER);
    // A refused call was answered: it is not pending, and the turn went on.
    expect(run.paused).toBe(false);
    expect(run.declined).toEqual([]);
    expect(run.value.response.text()).toBe("done");
    // The call that had budget is untouched.
    const first = resultsFor(e.requests[1].messages, "c1");
    expect(first[0].isError).toBe(false);
    expect(first[0].text).not.toContain(BUDGET_CODE);
  });

  it("overall budget across rounds: a later round's call is refused with the same code", async () => {
    const e = executor([[callPart("c1")], [callPart("c2")]]);
    const t = adapter();
    const run = await runHostedTools(e, request, [tool], t, { sessionId: "s", config: HostedToolOptionsSchema.parse({ maxCalls: 1 }) });
    expect(t.postStream).toHaveBeenCalledTimes(1);
    const shown = resultsFor(e.requests[2].messages, "c2");
    expect(shown).toHaveLength(1);
    expect(errorCode(shown[0])).toBe(BUDGET_CODE);
    expect(JSON.stringify(run.history)).not.toContain(PAUSE_MARKER);
    expect(run.paused).toBe(false);
  });

  it("every call past the budget in one round gets the code, none the pause marker", async () => {
    const e = executor([[callPart("c1"), callPart("c2"), callPart("c3"), callPart("c4")]]);
    const t = adapter();
    const run = await runHostedTools(e, request, [tool], t, { sessionId: "s", config: HostedToolOptionsSchema.parse({ maxCalls: 2 }) });
    expect(t.postStream).toHaveBeenCalledTimes(2);
    for (const ok of ["c1", "c2"]) expect(resultsFor(run.history, ok)[0].isError).toBe(false);
    for (const refused of ["c3", "c4"]) expect(errorCode(resultsFor(run.history, refused)[0])).toBe(BUDGET_CODE);
    expect(JSON.stringify(run.history)).not.toContain(PAUSE_MARKER);
    expect(JSON.stringify(run.traces)).not.toContain(PAUSE_MARKER);
  });

  it("a budget shared with a nested Micro Agent stage: the child's refused call carries the code", async () => {
    const e = executor([[callPart("c1")], [callPart("c2")]]);
    const t = adapter();
    const deps = { transport: t, catalog: {} } as unknown as ServiceDeps;
    const child = new HostedToolService(e as unknown as ModelService, deps, [tool]);
    const agent = new MicroAgent(
      parseService({ kind: "micro_agent", stages: [{ name: "stage", service: "child", input: [] }] }) as AgentDef,
      { ...deps, logMaxChars: 10_000, resolver: { resolve: () => ({ ok: true, executor: child, isAgent: false }), sttDef: () => ({ ok: false, message: "not used" }) } },
    );
    const run = await runHostedTools(agent, request, [tool], t, { sessionId: "shared", config: HostedToolOptionsSchema.parse({ maxCalls: 1 }) });
    expect(t.postStream).toHaveBeenCalledTimes(1);
    const last = run.traces.filter((ev) => ev.type === "hydrogen.tool.completed").at(-1)!;
    expect(last.isError).toBe(true);
    expect(JSON.stringify(last)).toContain(BUDGET_CODE);
    expect(JSON.stringify(last)).not.toContain(PAUSE_MARKER);
  });

  it("a pause (round ceiling) declines the call without the budget code: it stays pending", async () => {
    const e = executor([[callPart("c1")]]);
    const t = adapter();
    const run = await runHostedTools(e, request, [tool], t, { sessionId: "s", config: HostedToolOptionsSchema.parse({ maxRounds: 1 }) });
    expect(run.paused).toBe(true);
    expect(run.declined).toEqual(["c1"]);
    expect(run.value.response.stopReason).toBe("pause_turn");
    expect(t.postStream).not.toHaveBeenCalled();
    // Nothing about a paused call says "budget exhausted".
    const everything = JSON.stringify({ history: run.history, traces: run.traces, response: run.value.response.data(), calls: run.calls });
    expect(everything).not.toContain(BUDGET_CODE);
    // And it was not answered with an error result of any kind.
    expect(resultsFor(run.history, "c1").filter((r) => r.isError)).toEqual([]);
  });

  it("a pause with several pending calls declines every one, none with the budget code", async () => {
    const e = executor([[callPart("c1"), callPart("c2")]]);
    const run = await runHostedTools(e, request, [tool], adapter(), { sessionId: "s", config: HostedToolOptionsSchema.parse({ maxRounds: 1 }) });
    expect(run.paused).toBe(true);
    expect(run.declined).toEqual(["c1", "c2"]);
    expect(JSON.stringify({ history: run.history, traces: run.traces })).not.toContain(BUDGET_CODE);
  });

  it("neighbour: with budget to spare no call is refused or declined", async () => {
    const e = executor([[callPart("c1"), callPart("c2")]]);
    const t = adapter();
    const run = await runHostedTools(e, request, [tool], t, { sessionId: "s", config: HostedToolOptionsSchema.parse({ maxCalls: 2 }) });
    expect(t.postStream).toHaveBeenCalledTimes(2);
    expect(run.declined).toEqual([]);
    const all = JSON.stringify({ history: run.history, traces: run.traces });
    expect(all).not.toContain(BUDGET_CODE);
    expect(all).not.toContain(PAUSE_MARKER);
  });

  it("neighbour: a different tool error keeps its own code", async () => {
    const e = executor([[{ type: "tool_use", id: "c1", name: "lookup", input: { count: "bad" } }]]);
    const run = await runHostedTools(e, request, [tool], adapter(), { sessionId: "s" });
    const shown = resultsFor(run.history, "c1");
    expect(shown[0].isError).toBe(true);
    expect(errorCode(shown[0])).not.toBe(BUDGET_CODE);
    expect(errorCode(shown[0])).not.toBe(PAUSE_MARKER);
  });
});

// ---------------------------------------------------------------------------
// E5 / E6 -- the hosted-tool executor: `invoke` (buffered) against `stream`
// for the same failing run of the model underneath.
// ---------------------------------------------------------------------------

type Round =
  | { ok: true; attempts: number; content: ContentPart[] }
  | { ok: false; attempts: number; status: number; message: string };

/** A model executor whose every round is scripted, attempts included. */
function scriptedModel(rounds: Round[]) {
  const queue = rounds.map((r) => ({ ...r }));
  const path = (round: Round) => Array.from({ length: round.attempts }, (_, i) => ({
    step: 1, attempt: i + 1, model: "m", provider: "p", status: round.ok && i === round.attempts - 1 ? 200 : round.ok ? 503 : round.status, kind: "http", latencyMs: 0,
  }));
  const next = (): Round => queue.shift() ?? { ok: true, attempts: 1, content: [{ type: "text", text: "done" }] };
  const value = (content: ContentPart[]) => ({
    family: "openai_responses" as const, modelName: "m", providerName: "p", upstreamModel: "up", upstreamRequest: {},
    response: buildResponse("openai_responses", { id: "up", model: "up", created: 1, content, stopReason: content.some((p) => p.type === "tool_use") ? "tool_use" : "stop", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }),
  });
  let calls = 0;
  const invoke = async (): Promise<Invocation> => {
    calls += 1;
    const round = next();
    if (!round.ok) return { attempts: round.attempts, attemptPath: path(round), result: { ok: false, status: round.status, kind: "http", message: round.message } };
    return { attempts: round.attempts, attemptPath: path(round), result: { ok: true, value: value(round.content) } };
  };
  const stream = async (): Promise<StreamInvocation> => {
    calls += 1;
    const round = next();
    if (!round.ok) return { attempts: round.attempts, attemptPath: path(round), result: { ok: false, status: round.status, kind: "http", message: round.message } };
    const v = value(round.content);
    return { attempts: round.attempts, attemptPath: path(round), result: { ok: true, value: { ...v, dropReasoning: false, events: fabricateStream(v.response.data(), Infinity) } } };
  };
  return { invoke, stream, calls: () => calls };
}

interface Outcome { ok: boolean; status: number | null; attempts: number; pathStatuses: unknown[]; thrown: unknown }

/** Statuses of every recorded call/attempt in an attempt path, flattened in order. */
function statuses(pathValue: unknown): unknown[] {
  if (!Array.isArray(pathValue)) return [];
  return (pathValue as Array<Record<string, unknown>>).map((entry) => entry.status);
}

describe.each(["progress", "all", "final"] as const)("E5/E6: HostedToolService invoke vs stream (streamMode %s)", (streamMode) => {
  const service = (rounds: Round[]) => {
    const inner = scriptedModel(rounds);
    const t = adapter();
    const deps = { transport: t, catalog: {} } as unknown as ServiceDeps;
    const svc = new HostedToolService(inner as unknown as ModelService, deps, [tool], HostedToolOptionsSchema.parse({ streamMode }));
    return { svc, inner, t };
  };

  async function buffered(rounds: Round[]): Promise<Outcome> {
    const { svc } = service(rounds);
    const inv = await svc.invoke(request);
    return { ok: inv.result.ok, status: inv.result.ok ? null : inv.result.status, attempts: inv.attempts, pathStatuses: statuses(inv.attemptPath), thrown: null };
  }
  async function streamed(rounds: Round[]): Promise<Outcome> {
    const { svc } = service(rounds);
    const inv = await svc.stream(request.withStream(true));
    let thrown: unknown = null;
    if (inv.result.ok) {
      // A stream that committed must still be drained for the run to finish.
      try { for await (const event of inv.result.value.events) void event; } catch (error) { thrown = error; }
    }
    return { ok: inv.result.ok, status: inv.result.ok ? null : inv.result.status, attempts: inv.attempts, pathStatuses: statuses(inv.attemptPath), thrown };
  }

  describe.each([429, 500, 503])("round 1 calls the tool (2 attempts), round 2 fails with %i (3 attempts)", (failure) => {
    const rounds = (): Round[] => [
      { ok: true, attempts: 2, content: [callPart("c1")] },
      { ok: false, attempts: 3, status: failure, message: `scripted ${failure}` },
    ];

    it("E5: the buffered failure counts the nested attempts of both rounds", async () => {
      const b = await buffered(rounds());
      expect(b.ok).toBe(false);
      expect(b.attempts).toBe(5);
    });

    it("E5: the streamed failure reports the same attempt count as the buffered one", async () => {
      const b = await buffered(rounds());
      const s = await streamed(rounds());
      expect(s.thrown).toBeNull();
      expect(s.ok).toBe(false);
      expect(s.attempts).toBe(b.attempts);
      expect(s.attempts).toBe(5);
    });

    it("E6: the streamed failure carries and records the same status as the buffered one", async () => {
      const b = await buffered(rounds());
      const s = await streamed(rounds());
      expect(b.status).toBe(failure);
      expect(s.status).toBe(b.status);
      expect(s.pathStatuses).toEqual(b.pathStatuses);
    });
  });

  describe("the very first round fails (4 attempts)", () => {
    const rounds = (): Round[] => [{ ok: false, attempts: 4, status: 503, message: "scripted 503" }];

    it("E5/E6: same attempt count and status on both paths", async () => {
      const b = await buffered(rounds());
      const s = await streamed(rounds());
      expect(b.ok).toBe(false);
      expect(s.ok).toBe(false);
      expect(b.attempts).toBe(4);
      expect(s.attempts).toBe(4);
      expect(s.status).toBe(503);
      expect(s.status).toBe(b.status);
      expect(s.pathStatuses).toEqual(b.pathStatuses);
    });
  });

  describe("three rounds, the last one fails", () => {
    const rounds = (): Round[] => [
      { ok: true, attempts: 1, content: [callPart("c1")] },
      { ok: true, attempts: 3, content: [callPart("c2")] },
      { ok: false, attempts: 2, status: 429, message: "scripted 429" },
    ];

    it("E5/E6: 1 + 3 + 2 attempts and status 429 on both paths", async () => {
      const b = await buffered(rounds());
      const s = await streamed(rounds());
      expect(b.attempts).toBe(6);
      expect(s.attempts).toBe(6);
      expect(b.status).toBe(429);
      expect(s.status).toBe(429);
      expect(s.pathStatuses).toEqual(b.pathStatuses);
    });
  });

  it("neighbour: a successful run counts the same attempts on both paths", async () => {
    const rounds = (): Round[] => [
      { ok: true, attempts: 2, content: [callPart("c1")] },
      { ok: true, attempts: 1, content: [{ type: "text", text: "done" }] },
    ];
    const b = await buffered(rounds());
    const s = await streamed(rounds());
    expect(b.ok).toBe(true);
    expect(s.ok).toBe(true);
    expect(s.thrown).toBeNull();
    expect(b.attempts).toBe(3);
    expect(s.attempts).toBe(b.attempts);
  });
});

// ---------------------------------------------------------------------------
// E5 / E6 -- the whole product over HTTP: the same failing run, buffered and
// streamed, must leave the same attempt count and the same status in the log.
// ---------------------------------------------------------------------------

type Action = { kind: "tool"; id: string } | { kind: "text" } | { kind: "status"; status: number };

interface ModelUpstream { baseUrl: string; script: Action[]; requests: number; close(): Promise<void> }

/** An OpenAI-compatible upstream answering one scripted action per request. */
async function startModelUpstream(): Promise<ModelUpstream> {
  const state: ModelUpstream = { baseUrl: "", script: [], requests: 0, close: async () => {} };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (raw += c));
    req.on("end", () => {
      state.requests += 1;
      const action: Action = state.script.shift() ?? { kind: "text" };
      const streaming = (JSON.parse(raw) as { stream?: unknown }).stream === true;
      if (action.kind === "status") {
        res.writeHead(action.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `scripted ${action.status}` } }));
        return;
      }
      const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
      const message = action.kind === "tool"
        ? { role: "assistant", content: null, tool_calls: [{ id: action.id, type: "function", function: { name: "lookup", arguments: '{"count":3}' } }] }
        : { role: "assistant", content: "final answer" };
      const finish = action.kind === "tool" ? "tool_calls" : "stop";
      if (!streaming) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          id: "c", object: "chat.completion", created: 1, model: "up", choices: [{ index: 0, message, finish_reason: finish }], usage,
        }));
        return;
      }
      const chunk = (payload: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "up", ...payload })}\n\n`;
      const delta = action.kind === "tool"
        ? { tool_calls: [{ index: 0, id: action.id, type: "function", function: { name: "lookup", arguments: '{"count":3}' } }] }
        : { content: "final answer" };
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end([
        chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }),
        "data: [DONE]\n\n",
      ].join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

/** The operator's tool adapter. */
async function startAdapter(): Promise<{ url: string; calls: () => number; close(): Promise<void> }> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.writeHead(200, { "content-type": "application/json" }).end('{"result":{"answer":3}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/run`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface LogRow { http_status: number; attempts: number; streaming: number; error: string | null; attempt_path_json: string | null }

const CASES = (["progress", "all", "final"] as const).flatMap((streamMode) =>
  (["/v1/responses", "/v1/messages"] as const).map((endpoint) => ({ streamMode, endpoint })));

describe.each(CASES)("E5/E6: hosted-tool run that fails, buffered vs streamed ($endpoint, streamMode $streamMode)", ({ streamMode, endpoint }) => {
  let h: AdminHarness;
  let model: ModelUpstream;
  let adapterServer: Awaited<ReturnType<typeof startAdapter>>;
  let secret: string;
  const MAX_ATTEMPTS = 2;

  beforeAll(async () => {
    h = await startAdminHarness(`verify-exec-hosted-${streamMode}-${endpoint.replace(/\W/g, "")}`, {
      ALLOW_PRIVATE_UPSTREAMS: "1",
      STREAM_COMMIT_GRACE_MS: "600000",
      SIMULATED_STREAMING_TOKEN_RATE: "2000000",
    });
    model = await startModelUpstream();
    adapterServer = await startAdapter();
    const provider = h.c.providers.create({ name: "fake", type: "openai_completion", baseUrl: model.baseUrl, apiKey: "k" });
    const m = h.c.models.create({ name: "m" });
    h.c.mappings.create({ modelId: m.id, providerId: provider.id, upstreamModel: "up" });
    const definition = {
      timeoutMs: 10_000,
      steps: [{ model: "m", provider: "fake", retry: { maxAttempts: MAX_ATTEMPTS, intervalMs: 0, on: [429, 500, 503] } }],
      hostedTools: HostedToolOptionsSchema.parse({ streamMode }),
    };
    const service = h.c.services.create({ name: "svc", definition: definition as never });
    const created = h.c.hostedTools.create(HttpToolSchema.parse({
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false },
      url: adapterServer.url,
      bodyTemplate: { count: "{{arguments.count}}" },
      resultPath: "/result",
    }));
    h.c.hostedTools.bind(service.id, [created.id]);
    secret = h.c.tokens.create({ name: "t" }).secret;
  });

  afterAll(async () => {
    await h.close();
    await model.close();
    await adapterServer.close();
  });

  const send = (stream: boolean) =>
    h.app.inject({
      method: "POST",
      url: endpoint,
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      payload: endpoint === "/v1/responses"
        ? { model: "svc", stream, input: "look it up" }
        : { model: "svc", stream, max_tokens: 64, messages: [{ role: "user", content: "look it up" }] },
    });

  /** Run one scripted scenario and read back the log row it left. */
  async function runOnce(stream: boolean, script: Action[]): Promise<{ status: number; body: string; row: LogRow; upstreamRequests: number; adapterCalls: number }> {
    model.script = script.map((a) => ({ ...a }));
    const beforeRequests = model.requests;
    const beforeCalls = adapterServer.calls();
    const maxId = (h.c.sqlite.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM request_logs").get() as { id: number }).id;
    const res = await send(stream);
    let row: LogRow | undefined;
    for (let i = 0; i < 100 && !row; i++) {
      row = h.c.sqlite.prepare("SELECT * FROM request_logs WHERE id > ? ORDER BY id DESC LIMIT 1").get(maxId) as LogRow | undefined;
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    expect(row, "the request left no log row").toBeDefined();
    return { status: res.statusCode, body: res.body, row: row!, upstreamRequests: model.requests - beforeRequests, adapterCalls: adapterServer.calls() - beforeCalls };
  }

  it("neighbour: a successful hosted run works on both paths", async () => {
    const script: Action[] = [{ kind: "tool", id: "call_1" }, { kind: "text" }];
    const buffered = await runOnce(false, script);
    expect(buffered.status).toBe(200);
    expect(buffered.body).toContain("final answer");
    expect(buffered.adapterCalls).toBe(1);
    expect(buffered.row.http_status).toBe(200);
    const streamed = await runOnce(true, script);
    expect(streamed.status).toBe(200);
    expect(streamed.body).toContain("final answer");
    expect(streamed.adapterCalls).toBe(1);
    expect(streamed.row.http_status).toBe(200);
    expect(streamed.row.attempts).toBe(buffered.row.attempts);
  });

  // Round 1 succeeds (1 attempt) and asks for the tool; round 2 fails on every
  // attempt the step allows. The run made 1 + MAX_ATTEMPTS upstream attempts.
  describe.each([500, 503, 429])("second round fails with %i on every attempt", (failure) => {
    const script = (): Action[] => [{ kind: "tool", id: "call_1" }, ...Array.from({ length: MAX_ATTEMPTS }, () => ({ kind: "status" as const, status: failure }))];

    it("E5: the streamed run logs the same attempt count as the buffered run", async () => {
      const buffered = await runOnce(false, script());
      const streamed = await runOnce(true, script());
      // Both paths really made the same upstream attempts.
      expect(buffered.upstreamRequests).toBe(1 + MAX_ATTEMPTS);
      expect(streamed.upstreamRequests).toBe(1 + MAX_ATTEMPTS);
      expect(buffered.row.http_status).toBeGreaterThanOrEqual(400);
      expect(streamed.row.attempts).toBe(buffered.row.attempts);
    });

    it("E6: the streamed run logs the same status as the buffered run", async () => {
      const buffered = await runOnce(false, script());
      const streamed = await runOnce(true, script());
      expect(buffered.status).toBeGreaterThanOrEqual(400);
      expect(buffered.row.http_status).toBe(buffered.status);
      expect(streamed.row.http_status).toBe(buffered.row.http_status);
      expect(streamed.row.streaming).toBe(1);
      expect(buffered.row.streaming).toBe(0);
    });
  });

  // The log row is what an operator reads. Round 1 made one attempt and round
  // 2 made MAX_ATTEMPTS, so a count that includes the nested attempts is
  // 1 + MAX_ATTEMPTS -- on either path.
  describe("the logged attempt count of a run whose second round fails (503)", () => {
    const script = (): Action[] => [{ kind: "tool", id: "call_1" }, ...Array.from({ length: MAX_ATTEMPTS }, () => ({ kind: "status" as const, status: 503 }))];

    it("E5: streamed -- includes the nested attempts", async () => {
      const streamed = await runOnce(true, script());
      expect(streamed.upstreamRequests).toBe(1 + MAX_ATTEMPTS);
      expect(streamed.row.attempts).toBe(1 + MAX_ATTEMPTS);
    });

    it("E5 reference: buffered -- includes the nested attempts", async () => {
      const buffered = await runOnce(false, script());
      expect(buffered.upstreamRequests).toBe(1 + MAX_ATTEMPTS);
      expect(buffered.row.attempts).toBe(1 + MAX_ATTEMPTS);
    });
  });

  describe("first round fails outright (no tool ever runs)", () => {
    const script = (): Action[] => Array.from({ length: MAX_ATTEMPTS }, () => ({ kind: "status" as const, status: 500 }));

    it("E5/E6: same attempts and same status on both paths", async () => {
      const buffered = await runOnce(false, script());
      const streamed = await runOnce(true, script());
      expect(buffered.upstreamRequests).toBe(MAX_ATTEMPTS);
      expect(streamed.upstreamRequests).toBe(MAX_ATTEMPTS);
      expect(buffered.adapterCalls).toBe(0);
      expect(streamed.adapterCalls).toBe(0);
      expect(streamed.row.attempts).toBe(buffered.row.attempts);
      expect(streamed.row.http_status).toBe(buffered.row.http_status);
      expect(buffered.row.http_status).toBe(buffered.status);
    });
  });

  describe("a retry that recovers inside the second round", () => {
    it("neighbour: both paths succeed and count the same attempts", async () => {
      const script = (): Action[] => [{ kind: "tool", id: "call_1" }, { kind: "status", status: 503 }, { kind: "text" }];
      const buffered = await runOnce(false, script());
      const streamed = await runOnce(true, script());
      expect(buffered.status).toBe(200);
      expect(streamed.status).toBe(200);
      expect(buffered.upstreamRequests).toBe(3);
      expect(streamed.upstreamRequests).toBe(3);
      expect(streamed.row.http_status).toBe(200);
      expect(buffered.row.http_status).toBe(200);
      expect(streamed.row.attempts).toBe(buffered.row.attempts);
    });
  });
});
