import { buildRequest, buildResponse } from "../core/format/registry";
import type { Request } from "../core/ir/request";
import type { ContentPart, Message, ToolResultPart, ToolUsePart } from "../core/ir/content";
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
import { DEFAULT_SERVER_TOOL_NAME_PREFIX, localToolHistory, markLocalToolCall, pendingHostedCalls, pendingServerTools, prepareServerTools, retainServerToolReceipts, ServerToolPreflightError, validateServerToolBindings, type HostedServerTools, type HostedToolReceipt, type PreparedServerTools, type ServerToolRuntime } from "./serverTools";
import { toolValidator } from "./toolSchema";
import { withThinkingFormat, type ThinkingFormat } from "../core/ir/thinkingFormat";
import { genId } from "../util/ids";
import { serializeForLog } from "../util/logPayload";
import type { AttemptRecord } from "./steps";
import type { RequestOverrides } from "../core/ir/params";

export type HostedEvent = { type: string; round: number; [key: string]: unknown };
export interface HostedContext {
  logMaxChars?: () => number;
  thinkingFormat?: ThinkingFormat;
  sessionId: string;
  remainingCalls: number;
  /** Active nested ceilings; each real child call consumes every ancestor. */
  callLimits?: Array<{ remaining: number }>;
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
  /** True when the loop stopped to be continued rather than to answer. */
  paused: boolean;
  /** Calls a pause declined to run; they are reported to the client as pending. */
  declined: string[];
  /** Exact declarations/executors that this run actually owned, across rounds. */
  serverTools: HostedServerTools;
  /** Completed work available to enclosing loops as private receipts. */
  receipts: HostedToolReceipt[];
}
export class HostedRunError extends Error {
  constructor(message: string, readonly statusCode: number, readonly usage: Usage, readonly calls: ServiceCall[], readonly errorBody?: unknown) { super(message); }
}

/** One bounded model/tool loop. Tools are forwarded sequentially and never retried here. */
export async function runHostedTools(
  executor: Pick<ModelService, "invoke" | "stream"> & Partial<Pick<ModelService, "thinkingProcessing" | "prepareTools" | "serverToolNamePrefix">>,
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
    /** Frozen once for the run, preserving an explicitly empty prefix. */
    serverToolNamePrefix?: string;
    /** Caller overrides remain stronger than every step's own parameters. */
    modelOverrides?: RequestOverrides;
  },
): Promise<HostedRun> {
  const config = options.config ?? HostedToolOptionsSchema.parse({});
  const availability = { tools, prefix: options.serverToolNamePrefix ?? options.serverTools?.prefix ?? executor.serverToolNamePrefix ?? DEFAULT_SERVER_TOOL_NAME_PREFIX };
  validateServerToolBindings(tools, request.family);
  const context = options.hosted ?? { sessionId: options.sessionId, remainingCalls: config.maxCalls, remainingRounds: 128, traces: [], emit: options.emit, thinkingFormat: options.thinkingFormat, logMaxChars: options.logMaxChars };
  const localLimit = { remaining: config.maxCalls };
  const logMaxChars = context.logMaxChars ?? (() => 100_000);
  const invokeOptions: InvokeOptions = { ...options, hosted: context, serverTools: availability,
    thinkingProcessing: executor.thinkingProcessing !== false && options.thinkingProcessing !== false };
  const presentationFormat = invokeOptions.thinkingProcessing ? context.thinkingFormat : "original";
  const calls: ServiceCall[] = [], traces: HostedEvent[] = context.traces;
  let usage: Usage = { ...ZERO_USAGE }, attempts = 0;
  const fail = (message: string, status = 502, errorBody?: unknown): never => { throw new HostedRunError(message, status, usage, calls, errorBody); };
  const prepare = (input: Request): PreparedServerTools => executor.prepareTools
    ? executor.prepareTools(input, options.modelOverrides, invokeOptions)
    : prepareServerTools(input.withOverrides(options.modelOverrides), availability);
  const initial = prepare(request);
  // Work on a private history: resolving a pending wire call must not mutate a
  // caller's Request or another invocation sharing that history.
  const history: Message[] = structuredClone(request.messages);
  let runtime: ServerToolRuntime = initial;
  let matched = pendingServerTools(history, availability, runtime);
  const owned: HostedServerTools = new Map(matched);
  const receipts: HostedToolReceipt[] = [];
  let named = new Map([...matched].map(([name, entry]) => [name, entry.tool]));
  // A paused run ends with an assistant turn whose hosted calls were never run —
  // that shape IS the resume signal, so a client continuing from a saved
  // response needs no extra bookkeeping. Executing them here is what makes
  // `pause_turn` a continuation rather than a dead end: the pause happens
  // BEFORE a call is made, so the whole pending batch is replayable.
  // A resumed turn carries the client-declared name; bind it before anything
  // looks the call up, so the same resolution serves both the pending scan and
  // the model's own output below.
  const emit = async (event: HostedEvent, retain = true): Promise<void> => {
    if (retain) traces.push(event);
    if (options.emit && config.streamMode !== "final") await options.emit(event);
  };
  const seen = new Set<string>();
  /** The loop's answer to a spent budget: keep the turn, ask to be continued. */
  const pause = (value: InvokeValue, declined: string[]): HostedRun => ({
    value: { ...value, hostedToolReceipts: receipts, response: buildResponse(value.family, { ...value.response.data(), stopReason: "pause_turn", usage }) },
    history, calls, attempts, traces, paused: true, declined, serverTools: owned, receipts,
  });
  const done = (value: InvokeValue, content: ContentPart[]): HostedRun => ({
    value: { ...value, hostedToolReceipts: receipts, response: buildResponse(value.family, { ...value.response.data(), content, usage }) },
    history, calls, attempts, traces, paused: false, declined: [], serverTools: owned, receipts,
  });

  /**
   * Execute one batch of provider-executed calls.
   *
   * Nothing is sent until the whole batch fits the budget: a pause leaves every
   * call unexecuted, which is what lets a resumed request replay it. Returns
   * `null` when the batch must wait, having pushed whatever it completed.
   */
  const runBatch = async (batch: ToolUsePart[], round: number): Promise<ContentPart[] | null> => {
    if (context.remainingRounds <= 0) return null;
    const results: ContentPart[] = [];
    for (const call of batch) {
      options.signal?.throwIfAborted();
      if (seen.has(call.id)) fail("Model repeated a tool call ID; refusing to replay the operation");
      seen.add(call.id);
      const tool = named.get(call.name)!;
      const callId = genId("toolcall");
      await emit({ type: "hydrogen.tool.started", round, call_id: callId, model_call_id: call.id, name: call.name, arguments: call.input });
      options.progress?.record("llm", "tool.start", `hosted tool ${call.name} started`);
      const validate = toolValidator(tool.parameters);
      // A call the budget refuses is reported AS a call, with the reason. The
      // model can then adjust instead of the whole turn ending.
      const result = context.remainingCalls <= 0 || context.callLimits?.some(limit => limit.remaining <= 0)
        ? { output: JSON.stringify({ error: { code: "tool_call_limit", message: "Hosted tool call budget exhausted" } }), isError: true, durationMs: 0 }
        : !validate(call.input)
          ? { output: JSON.stringify({ error: { code: "invalid_tool_arguments", message: "Arguments do not match the tool parameter schema" } }), isError: true, durationMs: 0 }
          : await callHttpTool(tool, { arguments: call.input as Record<string, unknown>, tool: { name: tool.name }, call: { id: callId }, session: { id: options.sessionId } }, transport, options.signal);
      context.remainingCalls = Math.max(0, context.remainingCalls - 1);
      for (const limit of context.callLimits ?? []) limit.remaining = Math.max(0, limit.remaining - 1);
      const canonicalResult: ToolResultPart = { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: result.output }], isError: result.isError, hydrogenTool: structuredClone(call.hydrogenTool) };
      results.push(canonicalResult);
      receipts.push({ call: structuredClone(call), result: canonicalResult, entry: matched.get(call.name)! });
      await emit({ type: "hydrogen.tool.completed", round, call_id: callId, model_call_id: call.id, name: call.name, ...result });
      options.progress?.record("llm", "tool.complete", `hosted tool ${call.name} ${result.isError ? "returned an error" : "completed"}`);
    }
    history.push({ role: "user", content: results });
    return results;
  };

  // A resumed request still carries the assistant turn the pause stopped on, with
  // the calls it never ran. Run them before asking the model anything: they are
  // the work the pause declined, and the model's next turn depends on them.
  const pendingCalls = pendingHostedCalls(history, named);
  // Resuming pending adapter work can dispatch before a model step runs. Keep
  // the existing rejection at that boundary rather than replaying side effects.
  if (initial.preflightMismatch && pendingCalls.length) throw initial.preflightMismatch;
  (context.callLimits ??= []).push(localLimit);
  try {
  if (pendingCalls.length) {
    // Still spent: stay paused rather than half-running a batch.
    if (await runBatch(pendingCalls, 0) === null) fail("Hosted tool call budget is exhausted; raise it before resuming", 402);
  }
  for (let round = 1; round <= config.maxRounds; round++) {
    invokeOptions.serverToolRound = round;
    options.signal?.throwIfAborted();
    // This round is consumed by the model call below. Nested loops share the
    // budget, so a real exhaustion is still a hard failure; a request that merely
    // ran out of its OWN ceiling pauses below instead.
    if (--context.remainingRounds < 0) fail("Nested hosted tool loops reached the shared model-round limit");
    if (Buffer.byteLength(JSON.stringify(history)) > 25 * 1024 * 1024) fail("Tool-loop context exceeds 25 MiB", 413);
    const next = buildRequest(request.family, { ...request.data(), messages: [...history],
      // A forced tool choice applies to the first turn, not forever.
      toolChoice: round === 1 ? request.toolChoice : { type: "auto" } });
    const prepared = prepare(next);
    // A real executor must see original declarations so each fallback/stage
    // prepares its own policy. Small injected test/custom executors without a
    // preparation API receive this loop's explicitly prepared declarations.
    const modelRequest = executor.prepareTools ? next : buildRequest(next.family, { ...prepared.request.data(), messages: localToolHistory(prepared.request.messages) });
    let value: InvokeValue;
    if (options.onModelEvent || options.emit && config.streamMode === "all") {
      const started = Date.now();
      const inv = await executor.stream(modelRequest.withStream(true), executor.prepareTools ? options.modelOverrides : undefined, invokeOptions);
      attempts += inv.attempts;
      const path = Array.isArray(inv.attemptPath) ? inv.attemptPath : [];
      const nested = path.some(entry => entry && typeof entry === "object" && "stage" in entry);
      const call: ServiceCall = { stage: `tool round ${round}`, service: request.requestedService, kind: nested ? "agent" : "service", status: inv.result.ok ? 200 : failureStatus(inv.result),
        latencyMs: Date.now() - started, attempts: nested ? [] : path as AttemptRecord[], ...(nested ? { calls: path as ServiceCall[] } : {}), streamed: true };
      calls.push(call);
      if (!inv.result.ok) { call.error = failureMessage(inv.result); return fail(call.error, call.status, inv.result.errorBody); }
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
          if (event.type === "finish" && (event.incomplete || event.error)) throw new HostedRunError(event.error ?? "Upstream stream was interrupted", event.failure?.status ?? 502, roundUsage, calls);
          pendingBytes += Buffer.byteLength(JSON.stringify(event));
          if (pendingBytes > 25 * 1024 * 1024) throw new Error("Model presentation buffer exceeds 25 MiB");
          pending.push(event);
          yield event;
        }
      }
      async function* observe(): AsyncGenerator<StreamEvent> {
        for await (const event of withThinkingFormat(raw(), options.onModelEvent ? "original" : presentationFormat)) {
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
        usage = addUsage(usage, roundUsage); call.usage = roundUsage; call.status = options.signal?.aborted ? 499 : error instanceof HostedRunError ? error.statusCode : 502;
        call.latencyMs = Date.now() - started; call.error = error instanceof Error ? error.message : "Model stream failed";
        fail(call.error, call.status);
      }
      value = { ...stream, response: buildResponse(stream.family, collected!.data) };
      call.latencyMs = Date.now() - started; call.usage = value.response.usage;
      call.response = serializeForLog(value.response.toLogPayload(), logMaxChars());
    } else {
      const invoked = await callService(executor, modelRequest.withStream(false), executor.prepareTools ? options.modelOverrides : undefined,
        { stage: `tool round ${round}`, service: request.requestedService }, invokeOptions, logMaxChars);
      calls.push(invoked.call);
      attempts += invoked.attempts;
      if (!invoked.result.ok) {
        usage = addUsage(usage, invoked.call.usage ?? ZERO_USAGE);
        return fail(failureMessage(invoked.result), failureStatus(invoked.result), invoked.result.errorBody);
      }
      value = invoked.result.value;
    }
    usage = addUsage(usage, value.response.usage);
    const empty = missingAnswerReason(value.response.content, value.response.stopReason);
    if (empty) fail(empty);
    const childReceipts = value.hostedToolReceipts ?? [];
    receipts.push(...childReceipts);
    for (const receipt of retainServerToolReceipts(history, childReceipts)) owned.set(receipt.entry.emittedName, receipt.entry);
    history.push({ role: "assistant", content: value.response.content });
    const requested = value.response.content.filter((p): p is ToolUsePart => p.type === "tool_use");
    runtime = value.serverTools ?? prepared;
    matched = runtime.matched;
    named = new Map([...matched].map(([name, entry]) => [name, entry.tool]));
    for (const part of requested) {
      const entry = matched.get(part.name);
      if (!entry) continue;
      markLocalToolCall(part, entry);
      owned.set(entry.emittedName, entry);
    }
    const hosted = requested.filter(t => named.has(t.name));
    if (hosted.length && runtime.toolChoice?.type === "none") fail("Model called a hosted tool despite tool_choice:none");
    const client = requested.filter(t => !named.has(t.name));
    if (hosted.length > 128) fail("Model requested too many hosted tools in one round");

    // The budget is spent BEFORE a call is sent, never during one. A run that
    // paused left its calls unexecuted, so resuming replays them; a run that
    // would exceed its round ceiling pauses here, keeping what the model already
    // said and letting the client continue instead of receiving an error. The
    // CALL budget is different: it is judged per call below, so the model learns
    // which calls it may not make instead of losing the turn.
    // The ceiling only pauses when the round has nothing else to deliver: with a
    // client tool in the same round, the loop returns after running what it can,
    // because the client's own turn is what comes next.
    if (hosted.length && !client.length && (round >= config.maxRounds || context.remainingRounds <= 0)) {
      return pause(value, hosted.map(call => call.id));
    }
    if (hosted.length && (await runBatch(hosted, round)) === null) {
      return pause(value, hosted.map(call => call.id));
    }
    if (!hosted.length || client.length) {
      // The round's own client calls travel back; the ones the proxy ran become
      // their round trip instead.
      const content = value.response.content.filter(p => p.type !== "tool_use" || !named.has(p.name));
      return done(value, content);
    }
  }
  // Every exit inside the loop is explicit; reaching here means the loop ran out
  // of rounds without ever taking the pause path, which is a real failure.
  return fail("Hosted tool loop reached its model-round limit");
  } catch (error) {
    if (error instanceof HostedRunError) throw error;
    if (error instanceof ServerToolPreflightError) throw new HostedRunError(error.message, error.statusCode, usage, calls, error.errorBody);
    throw new HostedRunError(options.signal?.aborted ? "Response execution cancelled" : "Hosted tool execution failed", options.signal?.aborted ? 499 : 502, usage, calls);
  } finally {
    const index = context.callLimits?.indexOf(localLimit) ?? -1;
    if (index >= 0) context.callLimits!.splice(index, 1);
  }
}
