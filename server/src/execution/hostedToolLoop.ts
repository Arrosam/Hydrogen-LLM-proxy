import { buildRequest, buildResponse } from "../core/format/registry";
import type { Request } from "../core/ir/request";
import type { ContentPart, Message, ToolUsePart } from "../core/ir/content";
import { collectStream, withoutReasoning, type StreamEvent } from "../core/ir/stream";
import { addUsage, ZERO_USAGE, type Usage } from "../core/ir/usage";
import type { Transport } from "../core/upstream/transport";
import { missingAnswerReason } from "../core/ir/answer";
import { failureMessage, failureStatus } from "../core/proxy/errors";
import { callService, type ServiceCall } from "./serviceCall";
import type { ModelService, InvokeOptions } from "./modelService";
import type { InvokeValue } from "./outcome";
import { HostedToolOptionsSchema, type HostedToolOptions } from "./definition";
import { callHttpTool, type HttpTool } from "./toolHttp";
import { toolValidator } from "./toolSchema";
import { withThinkingFormat, type ThinkingFormat } from "../core/ir/thinkingFormat";
import { genId } from "../util/ids";
import { serializeForLog } from "../util/logPayload";
import type { AttemptRecord } from "./steps";

export type HostedEvent = { type: string; round: number; [key: string]: unknown };
export interface HostedContext {
  logMaxChars?: () => number;
  thinkingFormat?: ThinkingFormat;
  sessionId: string;
  remainingCalls: number;
  remainingRounds: number;
  traces: HostedEvent[];
  emit?: (event: HostedEvent) => Promise<void>;
}
export interface HostedRun {
  value: InvokeValue;
  history: Message[];
  calls: ServiceCall[];
  attempts: number;
  traces: HostedEvent[];
}
export class HostedRunError extends Error {
  constructor(message: string, readonly statusCode: number, readonly usage: Usage, readonly calls: ServiceCall[]) { super(message); }
}

/** One bounded model/tool loop. Tools are forwarded sequentially and never retried here. */
export async function runHostedTools(
  executor: Pick<ModelService, "invoke" | "stream">,
  request: Request,
  tools: HttpTool[],
  transport: Pick<Transport, "postStream">,
  options: InvokeOptions & {
    sessionId: string;
    config?: HostedToolOptions;
    emit?: (event: HostedEvent) => Promise<void>;
    onModelEvent?: (event: StreamEvent) => Promise<void>;
    thinkingFormat?: ThinkingFormat;
    logMaxChars?: () => number;
  },
): Promise<HostedRun> {
  const config = options.config ?? HostedToolOptionsSchema.parse({});
  const named = new Map(tools.filter(t => t.enabled).map(t => [t.name, t]));
  const context = options.hosted ?? { sessionId: options.sessionId, remainingCalls: config.maxCalls, remainingRounds: 128, traces: [], emit: options.emit, thinkingFormat: options.thinkingFormat, logMaxChars: options.logMaxChars };
  const logMaxChars = context.logMaxChars ?? (() => 100_000);
  const invokeOptions = { ...options, hosted: context };
  const calls: ServiceCall[] = [], traces: HostedEvent[] = context.traces;
  let usage: Usage = { ...ZERO_USAGE }, attempts = 0, callCount = 0;
  const fail = (message: string, status = 502): never => { throw new HostedRunError(message, status, usage, calls); };
  for (const tool of request.tools ?? []) if (named.has(tool.name) && !tool.hosted) fail(`Client tool name '${tool.name}' conflicts with a hosted tool`, 400);
  const definitions = [...(request.tools ?? []).filter(t => !named.has(t.name)), ...[...named.values()].map(t => ({ name: t.name, description: t.description, parameters: t.parameters, hosted: true }))];
  const history: Message[] = [...request.messages];
  const emit = async (event: HostedEvent, retain = true): Promise<void> => {
    if (retain) traces.push(event);
    if (options.emit && config.streamMode !== "final") await options.emit(event);
  };
  const seen = new Set<string>();
  try {
  for (let round = 1; round <= config.maxRounds; round++) {
    options.signal?.throwIfAborted();
    if (--context.remainingRounds < 0) fail("Nested hosted tool loops reached the shared model-round limit");
    if (Buffer.byteLength(JSON.stringify(history)) > 25 * 1024 * 1024) fail("Tool-loop context exceeds 25 MiB", 413);
    const next = buildRequest(request.family, { ...request.data(), messages: [...history], tools: definitions,
      // A forced tool choice applies to the first turn, not forever.
      toolChoice: round === 1 ? request.toolChoice : { type: "auto" } });
    let value: InvokeValue;
    if (options.onModelEvent || options.emit && config.streamMode === "all") {
      const started = Date.now();
      const inv = await executor.stream(next.withStream(true), undefined, invokeOptions);
      attempts += inv.attempts;
      const path = Array.isArray(inv.attemptPath) ? inv.attemptPath : [];
      const nested = path.some(entry => entry && typeof entry === "object" && "stage" in entry);
      const call: ServiceCall = { stage: `tool round ${round}`, service: request.requestedService, kind: nested ? "agent" : "service", status: inv.result.ok ? 200 : failureStatus(inv.result),
        latencyMs: Date.now() - started, attempts: nested ? [] : path as AttemptRecord[], ...(nested ? { calls: path as ServiceCall[] } : {}), streamed: true };
      calls.push(call);
      if (!inv.result.ok) { call.error = failureMessage(inv.result); return fail(call.error, call.status); }
      const stream = inv.result.value;
      call.request = serializeForLog(stream.upstreamRequest, logMaxChars());
      let roundUsage: Usage = { ...ZERO_USAGE };
      const events = stream.dropReasoning ? withoutReasoning(stream.events) : stream.events;
      const pending: StreamEvent[] = [];
      let pendingBytes = 0;
      async function* raw(): AsyncGenerator<StreamEvent> {
        for await (const event of events) {
          options.signal?.throwIfAborted();
          if (event.type === "usage" || event.type === "finish" && event.usage) roundUsage = event.usage!;
          if (event.type === "finish" && (event.incomplete || event.error)) throw new Error(event.error ?? "Upstream stream was interrupted");
          pendingBytes += Buffer.byteLength(JSON.stringify(event));
          if (pendingBytes > 25 * 1024 * 1024) throw new Error("Model presentation buffer exceeds 25 MiB");
          pending.push(event);
          yield event;
        }
      }
      async function* observe(): AsyncGenerator<StreamEvent> {
        for await (const event of withThinkingFormat(raw(), options.onModelEvent ? "original" : context.thinkingFormat)) {
          if (options.onModelEvent) await options.onModelEvent(event);
          else await emit({ type: "hydrogen.model.delta", round, event }, false);
          // Presentation may hide thinking; the model's continuation still needs its signed original.
          yield* pending.splice(0); pendingBytes = 0;
        }
        yield* pending.splice(0);
      }
      let collected;
      try { collected = await collectStream(observe()); }
      catch (error) {
        usage = addUsage(usage, roundUsage); call.usage = roundUsage; call.status = options.signal?.aborted ? 499 : 502;
        call.latencyMs = Date.now() - started; call.error = error instanceof Error ? error.message : "Model stream failed";
        fail(call.error, call.status);
      }
      value = { ...stream, response: buildResponse(stream.family, collected!.data) };
      call.latencyMs = Date.now() - started; call.usage = value.response.usage;
      call.response = serializeForLog(value.response.toLogPayload(), logMaxChars());
    } else {
      const invoked = await callService(executor, next.withStream(false), undefined,
        { stage: `tool round ${round}`, service: request.requestedService }, invokeOptions, logMaxChars);
      calls.push(invoked.call);
      attempts += invoked.attempts;
      if (!invoked.result.ok) {
        usage = addUsage(usage, invoked.call.usage ?? ZERO_USAGE);
        return fail(failureMessage(invoked.result), failureStatus(invoked.result));
      }
      value = invoked.result.value;
    }
    usage = addUsage(usage, value.response.usage);
    const empty = missingAnswerReason(value.response.content, value.response.stopReason);
    if (empty) fail(empty);
    history.push({ role: "assistant", content: value.response.content });
    const requested = value.response.content.filter((p): p is ToolUsePart => p.type === "tool_use");
    const hosted = requested.filter(t => named.has(t.name));
    if (hosted.length && request.toolChoice?.type === "none") fail("Model called a hosted tool despite tool_choice:none");
    const client = requested.filter(t => !named.has(t.name));
    if (hosted.length && !client.length && round === config.maxRounds) fail("Hosted tool loop reached its model-round limit");
    if (hosted.length > 128) fail("Model requested too many hosted tools in one round");
    const results: ContentPart[] = [];
    for (const call of hosted) {
      options.signal?.throwIfAborted();
      if (seen.has(call.id)) fail("Model repeated a tool call ID; refusing to replay the operation");
      seen.add(call.id);
      const tool = named.get(call.name)!;
      const callId = genId("toolcall");
      await emit({ type: "hydrogen.tool.started", round, call_id: callId, model_call_id: call.id, name: call.name, arguments: call.input });
      options.progress?.record("llm", "tool.start", `hosted tool ${call.name} started`);
      let result;
      const validate = toolValidator(tool.parameters);
      if (++callCount > config.maxCalls || --context.remainingCalls < 0) result = { output: JSON.stringify({ error: { code: "tool_call_limit", message: "Hosted tool call budget exhausted" } }), isError: true, durationMs: 0 };
      else if (!validate(call.input)) result = { output: JSON.stringify({ error: { code: "invalid_tool_arguments", message: "Arguments do not match the tool parameter schema" } }), isError: true, durationMs: 0 };
      else result = await callHttpTool(tool, { arguments: call.input as Record<string, unknown>, tool: { name: tool.name }, call: { id: callId }, session: { id: options.sessionId } }, transport, options.signal);
      results.push({ type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: result.output }], isError: result.isError });
      await emit({ type: "hydrogen.tool.completed", round, call_id: callId, model_call_id: call.id, name: call.name, ...result });
      options.progress?.record("llm", "tool.complete", `hosted tool ${call.name} ${result.isError ? "returned an error" : "completed"}`);
    }
    if (results.length) history.push({ role: "user", content: results });
    if (!hosted.length || client.length) {
      const content = value.response.content.filter(p => p.type !== "tool_use" || !named.has(p.name));
      return { value: { ...value, response: buildResponse(value.family, { ...value.response.data(), content, usage }) }, history, calls, attempts, traces };
    }
  }
  return fail("Hosted tool loop reached its model-round limit");
  } catch (error) {
    if (error instanceof HostedRunError) throw error;
    throw new HostedRunError(options.signal?.aborted ? "Response execution cancelled" : "Hosted tool execution failed", options.signal?.aborted ? 499 : 502, usage, calls);
  }
}
