import http from "node:http";
import type { AddressInfo } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import "../../src/core/format";
import type { Family } from "../../src/core/format/family";
import { buildRequest, serializeStream } from "../../src/core/format/registry";
import { fabricateStream } from "../../src/core/ir/stream";
import type { StreamEvent } from "../../src/core/ir/stream";
import { UpstreamClient } from "../../src/core/upstream/client";
import { SsrfGuard } from "../../src/core/upstream/ssrf";
import { ModelService } from "../../src/execution/modelService";
import { ServiceFactory } from "../../src/execution/serviceFactory";
import { ActiveRequestRegistry } from "../../src/observability/activeRequests";
import type { LogParams } from "../../src/observability/requestLogger";
import { ProxyController } from "../../src/transport/proxyController";
import type { ProxyDeps } from "../../src/transport/deps";
import type { Catalog } from "../../src/catalog/catalog";
import type {} from "../../src/auth/middleware";
import type {} from "@fastify/cookie";

export const families: Family[] = ["openai_completion", "anthropic", "openai_responses"];
export const endpoint = (f: Family) => f === "anthropic" ? "/v1/messages" : f === "openai_responses" ? "/v1/responses" : "/v1/chat/completions";
export const parameters = { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false };
export function fileArguments(bytes: number): string {
  const prefix = JSON.stringify({ path: "output.txt", content: "" });
  if (bytes < prefix.length) throw new Error("Fixture payload too small");
  return JSON.stringify({ path: "output.txt", content: "x".repeat(bytes - prefix.length) });
}
export function toolRequest(family: Family, stream = true, hosted = false) {
  return buildRequest(family, { requestedService: "svc", stream, params: {}, messages: [{ role: "user", content: [{ type: "text", text: "Write the file" }] }],
    ...(!hosted ? { tools: [{ name: "write_file", parameters }] } : {}) });
}

export interface ToolScenario {
  family: Family;
  args: string;
  deltaChars?: number;
  packetBytes?: number;
  delayMs?: number;
  /** Deliberately hold open after a complete terminal event. */
  holdOpen?: boolean;
  /** Stop after arguments, without sending any completion event. */
  truncate?: boolean;
  /** Keep sending comments after partial arguments (until the client aborts). */
  stall?: "silent" | "comments";
  /** Emit only a done/completed snapshot, as some compatible gateways do. */
  snapshotOnly?: boolean;
}

export function* toolFrames(s: ToolScenario): Generator<string> {
  const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const chat = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "c", model: "up", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const item = { id: "fc_1", type: "function_call", call_id: "call_1", name: "write_file", arguments: s.args, status: "completed" };
  if (s.family === "openai_completion") yield chat({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: "" } }] });
  else if (s.family === "anthropic") {
    yield frame("message_start", { message: { id: "msg_1", model: "up", usage: { input_tokens: 1, output_tokens: 0 } } });
    yield frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "call_1", name: "write_file", input: {} } });
  } else {
    yield frame("response.created", { response: { id: "resp_1", model: "up", created_at: 1 } });
    if (!s.snapshotOnly) yield frame("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
  }
  const chars = s.deltaChars ?? 1024;
  if (!s.snapshotOnly) for (let i = 0; i < s.args.length; i += chars) {
    const delta = s.args.slice(i, i + chars);
    if (s.family === "openai_completion") yield chat({ tool_calls: [{ index: 0, function: { arguments: delta } }] });
    else if (s.family === "anthropic") yield frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: delta } });
    else yield frame("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta });
    if (s.stall) return;
  }
  if (s.truncate) return;
  if (s.family === "openai_completion") {
    yield chat({}, "tool_calls");
    yield "data: [DONE]\n\n";
  } else if (s.family === "anthropic") {
    yield frame("content_block_stop", { index: 0 });
    yield frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
    yield frame("message_stop", {});
  } else {
    if (!s.snapshotOnly) {
      yield frame("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, arguments: s.args });
      yield frame("response.output_item.done", { output_index: 0, item });
    }
    yield frame("response.completed", { response: { id: "resp_1", model: "up", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  }
}

export function toolJson(s: ToolScenario): object {
  if (s.family === "openai_completion") return { id: "c", model: "up", choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: s.args } }] }, finish_reason: "tool_calls" }] };
  if (s.family === "anthropic") return { id: "msg_1", model: "up", content: [{ type: "tool_use", id: "call_1", name: "write_file", input: JSON.parse(s.args) }], stop_reason: "tool_use" };
  return { id: "resp_1", model: "up", status: "completed", output: [{ id: "fc_1", type: "function_call", call_id: "call_1", name: "write_file", arguments: s.args }] };
}

async function write(res: http.ServerResponse, chunk: Buffer): Promise<void> {
  if (res.destroyed) return;
  if (!res.write(chunk)) await new Promise<void>(resolve => {
    const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
    res.once("drain", done); res.once("close", done);
  });
}

export async function startToolHarness(s: ToolScenario, opts: { reliable?: boolean; timeoutMs?: number } = {}) {
  const upstreamTimes: { firstDelta?: number; lastDelta?: number; terminal?: number; closed?: number; deltas: number } = { deltas: 0 };
  const dispatches: Array<{ at: number; bytes: number }> = [];
  let modelCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk.toString();
      const body = JSON.parse(raw);
      res.once("close", () => { upstreamTimes.closed = performance.now(); });
      if (req.url === "/tool") {
        dispatches.push({ at: performance.now(), bytes: Buffer.byteLength(raw) });
        res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); return;
      }
      // Hosted continuation finishes after the first tool round.
      modelCalls++;
      if (modelCalls > 1 && /tool_result|"role":"tool"|function_call_output/.test(raw)) {
        if (body.stream) {
          res.setHeader("content-type", "text/event-stream");
          for await (const frame of serializeStream(s.family, fabricateStream({ id: "final", model: "up", created: 1, content: [{ type: "text", text: "written" }], stopReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }, Infinity), { model: "up" })) await write(res, Buffer.from(frame));
          res.end(); return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(s.family === "openai_completion" ? { choices: [{ message: { content: "written" }, finish_reason: "stop" }] }
          : s.family === "anthropic" ? { content: [{ type: "text", text: "written" }], stop_reason: "end_turn" }
          : { output: [{ type: "message", content: [{ type: "output_text", text: "written" }] }], status: "completed" }));
        return;
      }
      if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(toolJson(s))); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of toolFrames(s)) {
        if (res.destroyed) return;
        const isDelta = frame.includes('"partial_json"') || frame.includes('"response.function_call_arguments.delta"') || frame.includes('"function":{"arguments":');
        if (isDelta) { upstreamTimes.firstDelta ??= performance.now(); upstreamTimes.lastDelta = performance.now(); upstreamTimes.deltas++; }
        if (frame.includes("[DONE]") || frame.includes("event: message_stop") || frame.includes("event: response.completed")) upstreamTimes.terminal = performance.now();
        const bytes = Buffer.from(frame);
        for (let i = 0; i < bytes.length; i += s.packetBytes ?? 16384) {
          await write(res, bytes.subarray(i, i + (s.packetBytes ?? 16384)));
          await nextTurn(); // real TCP fragmentation, including multibyte boundaries
        }
        if (s.delayMs) await delay(s.delayMs);
      }
      while (!res.destroyed && (s.holdOpen || s.stall)) {
        if (s.stall === "comments" || s.holdOpen) await write(res, Buffer.from(": ping\n\n"));
        await delay(20);
      }
      res.end();
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const transport = new UpstreamClient(new SsrfGuard({ allowPrivate: true, allowlist: () => [] }));
  const catalog = { exists: () => true, resolve: () => ({ ok: true, target: { family: s.family, upstreamModel: "up", modelName: "m", providerName: "p", url: upstreamUrl + endpoint(s.family), headers: { "content-type": "application/json" }, upstream: {} } }) } as unknown as Catalog;
  const def = { timeoutMs: opts.timeoutMs ?? 5000, reliableStreaming: opts.reliable ?? false, steps: [{ model: "m", provider: "p", retry: { maxAttempts: 1, on: [], intervalMs: 0, idempotency: "read" as const } }] };
  const row = { id: 1, name: "svc", kind: "model_service", enabled: true, definition: def };
  const services = { getByName: () => row, get: () => row, def: () => def } as unknown as ProxyDeps["services"];
  const activeRequests = new ActiveRequestRegistry();
  const logs: LogParams[] = [];
  const factory = new ServiceFactory(services, { catalog, transport, simulatedStreamingTokenRate: Infinity }, 0);
  const irTimes: { firstDelta?: number; lastDelta?: number; terminal?: number; deltas: number } = { deltas: 0 };
  const track = (executor: ModelService): ModelService => {
    const stream = executor.stream.bind(executor);
    executor.stream = async (...args) => {
      const result = await stream(...args);
      if (result.result.ok) {
        const events = result.result.value.events;
        result.result.value.events = (async function* (): AsyncGenerator<StreamEvent> {
          for await (const e of events) {
            if (e.type === "tool_args_delta") { irTimes.firstDelta ??= performance.now(); irTimes.lastDelta = performance.now(); irTimes.deltas++; }
            if (e.type === "finish") irTimes.terminal = performance.now();
            yield e;
          }
        })();
      }
      return result;
    };
    return executor;
  };
  const forRow = factory.forRow.bind(factory);
  factory.forRow = (...args) => { const result = forRow(...args); track(result.executor); return result; };
  const deps: ProxyDeps = { services, factory, catalog, transport, activeRequests,
    tokens: { authenticate: () => ({ id: 1, enabled: true }), incrementUsage: () => {} } as unknown as ProxyDeps["tokens"],
    logger: { capture: () => "", record: (p: LogParams) => { logs.push(p); }, amendDeliveryFailure: () => {} } as unknown as ProxyDeps["logger"],
    usage: { record: () => {} } as unknown as ProxyDeps["usage"], streamCommitGraceMs: 100, streamPingIntervalMs: 100, jsonCommitGraceMs: 0 };
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });
  new ProxyController(deps).register(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, transport, executor: track(new ModelService(def, { catalog, transport })), upstreamUrl, proxyUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, upstreamTimes, irTimes, logs, activeRequests, dispatches,
    async close() { app.server.closeAllConnections(); await app.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); } };
}

/** Independent, linear reference decoder: never use Hydrogen's parser to judge itself. */
export async function* referenceFrames(chunks: AsyncIterable<Buffer>): AsyncGenerator<Record<string, any>> {
  const decoder = new StringDecoder("utf8");
  let lineParts: string[] = [], data: string[] = [];
  for await (const chunk of chunks) {
    const text = decoder.write(chunk);
    let start = 0;
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", start)) {
      lineParts.push(text.slice(start, i));
      const line = lineParts.join("").replace(/\r$/, ""); lineParts = []; start = i + 1;
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      if (!line && data.length) {
        const raw = data.join("\n"); data = [];
        yield raw === "[DONE]" ? { type: "done" } : JSON.parse(raw);
      }
    }
    if (start < text.length) lineParts.push(text.slice(start));
  }
}

export async function observeCall(url: string, family: Family, stream = true, signal = AbortSignal.timeout(15000), readDelayMs = 0) {
  const started = performance.now();
  const body = toolRequest(family, stream).render({ upstreamModel: "svc" });
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(url + endpoint(family), { method: "POST", signal, headers: { "content-type": "application/json", authorization: "Bearer test" } }, resolve);
    req.on("error", reject); req.end(JSON.stringify(body));
  });
  let firstToolMs: number | undefined, firstDeltaMs: number | undefined, argsDoneMs: number | undefined;
  let terminal = false, error: unknown, json: any;
  const pieces: string[] = [], times: number[] = [];
  try {
    if (!stream) {
      let raw = ""; for await (const chunk of res) raw += chunk;
      json = JSON.parse(raw); terminal = !json.error; error = json.error ?? undefined;
    } else for await (const e of referenceFrames((async function* () {
      for await (const chunk of res) { if (readDelayMs) await delay(readDelayMs); yield chunk as Buffer; }
    })())) {
      const call = e.choices?.[0]?.delta?.tool_calls?.[0];
      if (call?.id || e.type === "content_block_start" && e.content_block?.type === "tool_use" || e.type === "response.output_item.added" && e.item?.type === "function_call") firstToolMs ??= performance.now() - started;
      const delta = call?.function?.arguments ?? e.delta?.partial_json ?? (e.type === "response.function_call_arguments.delta" ? e.delta : undefined);
      if (typeof delta === "string" && delta) { firstDeltaMs ??= performance.now() - started; pieces.push(delta); times.push(performance.now() - started); }
      if (e.type === "response.function_call_arguments.done" || e.type === "content_block_stop" || e.choices?.[0]?.finish_reason) argsDoneMs ??= performance.now() - started;
      if (["done", "message_stop", "response.completed"].includes(e.type)) terminal = true;
      if (e.type === "response.completed" && !pieces.length) {
        const call = e.response?.output?.find((item: any) => item.type === "function_call");
        if (call) { pieces.push(call.arguments); firstToolMs ??= performance.now() - started; argsDoneMs ??= performance.now() - started; }
      }
      if (e.error) error = e.error;
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  const args = pieces.join("");
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  return { started, status: res.statusCode, firstToolMs, firstDeltaMs, lastDeltaMs: times.at(-1), argsDoneMs, totalMs: performance.now() - started,
    maxGapMs: gaps.at(-1) ?? 0, deltas: times.length, terminal, error, args, json };
}
