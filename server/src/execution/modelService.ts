import { buildRequest } from "../core/format/registry";
import type { Family, RequestOverrides } from "../core/ir/params";
import type { Request } from "../core/ir/request";
import { inlineUrlFiles, needsUrlFileInlining } from "./fileFetch";
import { fabricateStream } from "../core/ir/stream";
import type { SendTarget, Transport } from "../core/upstream/transport";
import type { Catalog } from "../catalog/catalog";
import { runSteps } from "./steps";
import { stepOverrides, type ServiceStep, type ServiceSteps } from "./definition";
import type { Invocation, InvokeValue, StreamInvocation, StreamValue } from "./outcome";
import type { ProgressRecorder } from "../observability/progressRecorder";
import { addUsage, ZERO_USAGE, type Usage } from "../core/ir/usage";
import { buildResponse } from "../core/format/registry";
import { resolveTools, toolsForUpstream } from "./toolPolicy";
import { DispatchBudget, dispatchTool } from "./toolDispatch";
import { appendToolTurn, describeTool, mayDispatch, shouldContinue, splitToolCalls, type ToolRuntime } from "./toolLoop";
import type { DispatchableTool } from "../persistence/toolRepo";
import type { ActiveRequestRegistry } from "../observability/activeRequests";

/** Merge allowlisted client feature headers (e.g. anthropic-beta) into the
 * upstream headers — only for an upstream of the SAME wire family, and never
 * overriding anything the provider config already sets (auth included). */
function mergeForwardHeaders(
  base: Record<string, string>,
  fwd: RequestOverrides["forwardHeaders"] | undefined,
  family: string,
): Record<string, string> {
  if (!fwd || fwd.family !== family) return base;
  return { ...fwd.headers, ...base };
}

/**
 * How many times the tool loop may ask the upstream again.
 *
 * Bounded separately from the per-tool `max_uses` and the budget's overall
 * dispatch cap: those stop a tool RUNNING again, but a model that keeps calling
 * an exhausted tool is told "out of uses" and calls again, and every refusal
 * still costs a real upstream round trip. Measured at 200+ round trips for one
 * client request before this existed.
 */
const MAX_TOOL_ROUNDS = 16;

/** Resolve a possibly-live token rate (number | getter). Default 2000. */
function resolveRate(r: number | (() => number) | undefined): number {
  if (r == null) return 2000;
  return typeof r === "function" ? r() : r;
}

/** Shared dependencies every executor needs. */
export interface ServiceDeps {
  catalog: Catalog;
  transport: Transport;
  /** Optional active-request registry for real-time progress tracking. */
  progress?: ActiveRequestRegistry | null;
  /** Token rate (tokens/second) for simulated/fabricated streams. Default 2000.
   * A getter is accepted so the rate can be changed at runtime from the dashboard. */
  simulatedStreamingTokenRate?: number | (() => number);
  /** Auto-cache breakpoint lifetime in minutes (Settings, default 30). */
  promptCacheTtlMinutes?: number | (() => number);
  /** Server-side tools. Absent/null = no tool can ever be dispatched, and every
   * path below behaves exactly as it did before the feature existed. */
  tools?: ToolRuntime | null;
}

export interface InvokeOptions {
  /** Aborts the upstream call (client disconnect). */
  signal?: AbortSignal;
  /** Override the step-chain timeout (an agent stage may set its own). */
  timeoutMs?: number;
  /** Names of the agents currently on the call stack (nested-agent cycle guard). */
  stack?: string[];
  /** Progress recorder for emitting real-time events (null = no tracking). */
  progress?: ProgressRecorder | null;
  /** Free-form tool names granted on top of the service's own -- a Micro Agent
   * stage adds its own and the agent's here (E5). */
  grantTools?: string[];
  /** Shared across a Micro Agent's stages, so max_uses bounds the whole client
   * request rather than resetting at every stage. */
  dispatchBudget?: DispatchBudget;
  /** Tool ids the calling client key may dispatch. Null/absent = no limit.
   * Per request rather than per service, because it comes from the key. */
  allowedToolIds?: number[] | null;
}

/**
 * A Model Service: a resilience step chain. `invoke` runs the steps buffered and
 * returns one complete Response (each step streams its upstream and buffers, so
 * a truncated stream is a retryable failure and reasoning from stream-only
 * providers is captured). `stream` relays the winning upstream stream straight
 * to the client (commits on 2xx headers). Both apply the caller's overrides on
 * top of each step's own config, precedence override > step config > client.
 *
 * A Micro Agent extends this class and overrides `invoke`/`stream`, so it is
 * substitutable wherever a Model Service is expected (a stage can call either).
 */
export class ModelService {
  constructor(
    protected readonly def: ServiceSteps,
    protected readonly deps: ServiceDeps,
  ) {}

  /** The step chain's timeout, exposed so an agent stage can override it. */
  get timeoutMs(): number {
    return this.def.timeoutMs;
  }

  /** Layer the request with the step's config then the caller's override (override wins). */
  private merge(request: Request, step: ServiceStep, overrides?: RequestOverrides): Request {
    let merged = request.withOverrides(stepOverrides(step)).withOverrides(overrides);
    // Thread the operator's auto-cache TTL to renderers that need it (only the
    // Anthropic renderer reads it, and only when the client hinted caching).
    if (merged.params.cacheHint && merged.params.cacheTtlMinutes == null) {
      const ttl = this.deps.promptCacheTtlMinutes;
      merged = merged.withOverrides({ cacheTtlMinutes: typeof ttl === "function" ? ttl() : ttl ?? 30 });
    }
    return merged;
  }

  /** Inline any URL attachment the egress family cannot carry, announcing the
   * download so a slow fetch is visible in the live progress feed rather than
   * looking like the upstream hanging. */
  private async inlineFiles(
    merged: Request,
    family: Family,
    prog: ProgressRecorder | null,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Request> {
    if (!needsUrlFileInlining(merged, family)) return merged;
    prog?.record("llm", "llm.files", `downloading URL attachment(s) to inline for ${family}`, { family });
    return inlineUrlFiles(merged, family, this.deps.transport, opts);
  }

  /**
   * One pass down the step chain, buffered.
   *
   * With `tools` present, each step resolves who serves what against THAT
   * provider's capabilities and swaps the request's tool list for the
   * upstream-facing one, then reports back what may be dispatched. Resolution is
   * per step rather than per request because the answer changes with the
   * provider: the same tool the first step passes through natively is one the
   * fallback step needs Hydrogen to serve.
   */
  private async runChain(
    request: Request,
    overrides: RequestOverrides | undefined,
    opts: InvokeOptions,
    tools: { runtime: ToolRuntime; grants: string[] } | null,
  ): Promise<Invocation> {
    const prog = opts.progress ?? null;
    const { result, path } = await runSteps<InvokeValue>(this.def, async (step, stepIndex) => {
      prog?.record("llm", "step.start", `step ${stepIndex + 1}: ${step.model}@${step.provider} attempt starting`);
      const res = this.deps.catalog.resolve(step.model, step.provider, request.family);
      if (!res.ok) {
        prog?.record("error", "step.resolve", `mapping ${step.model}@${step.provider}: ${res.error}`);
        return { ok: false, status: 0, kind: "error", message: `mapping ${step.model}@${step.provider}: ${res.error}` };
      }
      const t = res.target;
      let merged = this.merge(request, step, overrides);
      const timeoutMs = opts.timeoutMs ?? this.def.timeoutMs;

      // Who serves each tool, against THIS provider's capabilities.
      let dispatchable: Map<string, DispatchableTool> | undefined;
      if (tools) {
        const resolved = resolveTools({
          declared: merged.tools,
          grants: tools.grants,
          capabilities: t.toolCapabilities,
          lookup: tools.runtime.lookup,
          allowedToolIds: opts.allowedToolIds,
        });
        for (const d of resolved.decisions) {
          if (d.outcome === "drop") prog?.record("llm", "tool.drop", `tool "${d.tool.name}" dropped: ${d.reason}`, { tool: d.tool.name });
        }
        const upstreamTools = toolsForUpstream(resolved, describeTool);
        merged = merged.withTools(upstreamTools.length ? upstreamTools : undefined);
        // A tool_choice that names a tool we just dropped -- or any choice at all
        // once nothing is left -- is a guaranteed upstream 400. Clearing it is
        // part of the same drop, not a second rewrite: the caller's instruction
        // became unsatisfiable when its subject went away, and it is logged.
        const choice = merged.toolChoice;
        const gone =
          choice != null &&
          ((upstreamTools.length === 0 && choice.type !== "none") ||
            (choice.type === "tool" && !upstreamTools.some((tool) => tool.name === choice.name)));
        if (gone) {
          prog?.record("llm", "tool.choice", `tool_choice dropped: the tool it required is not available on ${t.providerName}`);
          merged = merged.withToolChoice(undefined);
        }
        dispatchable = resolved.dispatchable;
      }

      // A URL attachment this family cannot carry is downloaded and inlined
      // first (see fileFetch). Resolved per step, because the very same request
      // needs no pre-pass at all on a family that takes URLs natively.
      const ready = await this.inlineFiles(merged, t.family, prog, { timeoutMs, signal: opts.signal });
      const egress = buildRequest(t.family, ready.data());
      const target: SendTarget = {
        upstreamModel: t.upstreamModel,
        url: t.url,
        headers: mergeForwardHeaders(t.headers, merged.params.forwardHeaders, t.family),
        providerMaxOutputTokens: t.providerMaxOutputTokens,
        timeoutMs,
        signal: opts.signal,
        proxy: t.upstream.proxy,
      };
      prog?.record("llm", "llm.serialize", `parameters serialized for ${t.family} -> ${t.upstreamModel}`, { family: t.family, model: t.upstreamModel });
      prog?.record("llm", "llm.send", `request initiated to ${t.upstreamModel} (${t.providerName})`, { model: t.upstreamModel, provider: t.providerName, url: t.url });
      const sent = await egress.send(this.deps.transport, target);
      if (!sent.ok) {
        prog?.record("llm", "llm.receive", `upstream returned ${sent.status}: ${sent.message}`, { status: sent.status });
        return { ok: false, status: sent.status, kind: sent.kind, message: sent.message, errorBody: sent.body };
      }
      prog?.record("llm", "llm.receive", `response generated and received from ${t.upstreamModel}`, { status: 200 });
      prog?.record("llm", "llm.result", `result parsed and ready for return`, { model: t.upstreamModel });
      // Honor a "disabled" thinking level end-to-end even if the upstream ignored it.
      let response = sent.response;
      if (merged.params.thinking === "disabled") response = response.withoutReasoning();
      return {
        ok: true,
        value: {
          response,
          family: t.family,
          upstreamModel: t.upstreamModel,
          providerName: t.providerName,
          modelName: t.modelName,
          upstreamRequest: sent.sentBody,
          ...(dispatchable ? { dispatchable } : {}),
        },
      };
    }, { progress: prog, signal: opts.signal });
    return { result, attemptPath: path, attempts: path.length };
  }

  async invoke(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<Invocation> {
    const runtime = this.deps.tools ?? null;
    const grants = [...(this.def.grantTools ?? []), ...(opts.grantTools ?? [])];
    // Nothing configured could ever be dispatched: take exactly the path this
    // service took before the feature existed, with no extra objects built.
    if (!runtime || !mayDispatch(request, grants, runtime)) {
      return this.runChain(request, overrides, opts, null);
    }
    return this.runToolLoop(request, overrides, opts, { runtime, grants });
  }

  /**
   * Ask, dispatch what the model called, ask again.
   *
   * The loop wraps the STEP CHAIN rather than living inside it, which is what
   * makes a fallback behave the way S12 requires: each round runs the whole
   * chain against the conversation so far, so a step that dies mid-loop hands
   * the accumulated history to the next step instead of restarting the turn.
   * Results already in the conversation are never re-derived, so an operator's
   * endpoint is never fired twice for one client request -- which matters
   * because it may be a write.
   */
  private async runToolLoop(
    request: Request,
    overrides: RequestOverrides | undefined,
    opts: InvokeOptions,
    tools: { runtime: ToolRuntime; grants: string[] },
  ): Promise<Invocation> {
    const prog = opts.progress ?? null;
    const budget = opts.dispatchBudget ?? new DispatchBudget();
    // `Invocation.attemptPath` is deliberately `unknown` (it is log payload, not
    // control flow), so the rounds are concatenated as opaque entries.
    const path: unknown[] = [];
    let convo = request;
    let usage: Usage = ZERO_USAGE;
    // The budget is shared across a Micro Agent's stages, so its running total is
    // not this invocation's count. Reporting the total on every stage and then
    // letting the agent SUM the stages counted 3 real dispatches as 6.
    const dispatchesBefore = budget.dispatches;
    const spent = (): number => budget.dispatches - dispatchesBefore;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const inv = await this.runChain(convo, overrides, opts, tools);
      path.push(...(Array.isArray(inv.attemptPath) ? inv.attemptPath : [inv.attemptPath]));
      if (!inv.result.ok) return { result: inv.result, attemptPath: path, attempts: path.length };

      const v = inv.result.value;
      usage = addUsage(usage, v.response.usage);
      const split = splitToolCalls(v.response, v.dispatchable ?? new Map());

      if (!shouldContinue(split)) {
        // Done. The client's copy reports what the WHOLE turn cost, the way a
        // provider running its own tool loop inside one request does (S14).
        const total: Usage = { ...usage, ...(spent() ? { toolDispatches: spent() } : {}) };
        const response = buildResponse(v.response.family, { ...v.response.data(), usage: total });
        return {
          result: { ok: true, value: { ...v, response } },
          attemptPath: path,
          attempts: path.length,
        };
      }

      const results: Array<{ call: (typeof split.ours)[number]; output: string; isError: boolean }> = [];
      for (const call of split.ours) {
        const entry = v.dispatchable!.get(call.name)!;
        const allowed = budget.take(entry);
        if (!allowed.ok) {
          // Out of budget is told to the model, not raised to the client: it can
          // answer with what it already has (S14).
          prog?.record("llm", "tool.budget", allowed.error, { tool: call.name });
          results.push({ call, output: allowed.error, isError: true });
          continue;
        }
        prog?.record("llm", "tool.dispatch", `dispatching tool "${call.name}" to ${entry.endpointUrl}`, { tool: call.name });
        const r = await dispatchTool(entry, { tool: call.name, arguments: call.input, call_id: call.id }, tools.runtime.dispatch);
        prog?.record("llm", "tool.result", r.ok ? `tool "${call.name}" returned` : `tool "${call.name}" failed: ${r.error}`, { tool: call.name, ok: r.ok });
        results.push({ call, output: r.ok ? r.output : r.error, isError: !r.ok });
      }
      convo = appendToolTurn(convo, v.response, results);
    }

    // Out of rounds with the model still calling tools. One last pass with
    // nothing dispatchable, so it answers with what it has rather than the
    // client receiving a tool call it never asked for and cannot run.
    prog?.record("llm", "tool.rounds", `tool loop stopped after ${MAX_TOOL_ROUNDS} rounds`);
    const final = await this.runChain(convo, overrides, opts, null);
    path.push(...(Array.isArray(final.attemptPath) ? final.attemptPath : [final.attemptPath]));
    if (!final.result.ok) return { result: final.result, attemptPath: path, attempts: path.length };
    const fv = final.result.value;
    const finalUsage: Usage = { ...addUsage(usage, fv.response.usage), ...(spent() ? { toolDispatches: spent() } : {}) };
    return {
      result: { ok: true, value: { ...fv, response: buildResponse(fv.response.family, { ...fv.response.data(), usage: finalUsage }) } },
      attemptPath: path,
      attempts: path.length,
    };
  }

  /** Wrap a buffered invocation as a fabricated (paced) client stream. Shared by
   * reliable-streaming Model Services and Micro Agents (which always buffer).
   * The pacing rate is configurable via ServiceDeps.simulatedStreamingTokenRate.
   * `startedAt` is when the run began, so the upstream time (retries included)
   * counts against the pacing budget instead of being added to it. */
  protected fabricated(inv: Invocation, startedAt?: number): StreamInvocation {
    if (!inv.result.ok) return { result: inv.result, attemptPath: inv.attemptPath, attempts: inv.attempts };
    const v = inv.result.value;
    const tokenRate = resolveRate(this.deps.simulatedStreamingTokenRate);
    return {
      result: {
        ok: true,
        value: {
          events: fabricateStream(v.response.data(), tokenRate, startedAt),
          family: v.family,
          upstreamModel: v.upstreamModel,
          providerName: v.providerName,
          modelName: v.modelName,
          upstreamRequest: v.upstreamRequest,
          // Reasoning was already stripped in invoke() if the level was disabled.
          dropReasoning: false,
        },
      },
      attemptPath: inv.attemptPath,
      attempts: inv.attempts,
    };
  }

  async stream(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<StreamInvocation> {
    const prog = opts.progress ?? null;
    const startedAt = Date.now();
    // Reliable streaming: buffer the upstream (retrying a truncated stream) and
    // replay the complete result as a paced simulated stream — the client never
    // gets a partial/truncated stream, at the cost of first-token latency.
    //
    // We do NOT override stream=false on the request: the client's streaming
    // preference is preserved. The invoke() path uses sendBuffered, which
    // honors the request's own stream flag — when stream=true the upstream is
    // streamed and collected (capturing reasoning from stream-only providers
    // and enabling truncation detection); when stream=false a plain JSON
    // request is sent. Either way the full response is buffered locally before
    // fabrication, so the client always receives a complete, paced stream.
    //
    // A tool loop buffers for a second reason: it makes several upstream round
    // trips and only the last one's text is the answer. Relaying the first
    // straight through would stream the model's tool CALL to the client as if it
    // were the reply, and then a second reply after it.
    //
    // NOTE (S13): the spec wants the tool call and its result streamed live
    // while text stays buffered. That needs a client-visible shape for a
    // server-executed tool -- `server_tool_use` and its result block -- which is
    // Path A emission, and those shapes are unmeasured. Until then the whole
    // loop is buffered and replayed, which is correct but shows the tool
    // activity only once the answer arrives.
    const toolRuntime = this.deps.tools ?? null;
    const toolGrants = [...(this.def.grantTools ?? []), ...(opts.grantTools ?? [])];
    if (this.def.reliableStreaming || mayDispatch(request, toolGrants, toolRuntime)) {
      return this.fabricated(await this.invoke(request, overrides, opts), startedAt);
    }
    const { result, path } = await runSteps<StreamValue>(this.def, async (step, stepIndex) => {
      prog?.record("llm", "step.start", `stream step ${stepIndex + 1}: ${step.model}@${step.provider} attempt starting`);
      const res = this.deps.catalog.resolve(step.model, step.provider, request.family);
      if (!res.ok) {
        prog?.record("error", "step.resolve", `mapping ${step.model}@${step.provider}: ${res.error}`);
        return { ok: false, status: 0, kind: "error", message: `mapping ${step.model}@${step.provider}: ${res.error}` };
      }
      const t = res.target;
      const merged = this.merge(request, step, overrides);
      const timeoutMs = opts.timeoutMs ?? this.def.timeoutMs;
      const ready = await this.inlineFiles(merged, t.family, prog, { timeoutMs, signal: opts.signal });
      const egress = buildRequest(t.family, ready.data());
      const target: SendTarget = {
        upstreamModel: t.upstreamModel,
        url: t.url,
        headers: mergeForwardHeaders(t.headers, merged.params.forwardHeaders, t.family),
        providerMaxOutputTokens: t.providerMaxOutputTokens,
        timeoutMs,
        signal: opts.signal,
        proxy: t.upstream.proxy,
      };
      prog?.record("llm", "llm.serialize", `parameters serialized for ${t.family} -> ${t.upstreamModel} (streaming)`, { family: t.family, model: t.upstreamModel });
      prog?.record("llm", "llm.send", `stream request initiated to ${t.upstreamModel} (${t.providerName})`, { model: t.upstreamModel, provider: t.providerName, url: t.url });
      const sent = await egress.relay(this.deps.transport, target);
      if (!sent.ok) {
        prog?.record("llm", "llm.receive", `upstream returned ${sent.status}: ${sent.message}`, { status: sent.status });
        return { ok: false, status: sent.status, kind: sent.kind, message: sent.message, errorBody: sent.body };
      }
      prog?.record("llm", "llm.receive", `stream committed from ${t.upstreamModel} (headers received)`, { status: sent.status });
      prog?.record("llm", "llm.result", `stream events ready for relay`, { model: t.upstreamModel });
      return {
        ok: true,
        value: {
          events: sent.events,
          family: t.family,
          upstreamModel: t.upstreamModel,
          providerName: t.providerName,
          modelName: t.modelName,
          upstreamRequest: sent.sentBody,
          dropReasoning: merged.params.thinking === "disabled",
        },
      };
    }, { progress: prog, signal: opts.signal });
    return { result, attemptPath: path, attempts: path.length };
  }
}
