import { buildRequest } from "../core/format/registry";
import type { RequestOverrides } from "../core/ir/params";
import type { Request } from "../core/ir/request";
import { fabricateStream } from "../core/ir/stream";
import type { SendTarget, Transport } from "../core/upstream/transport";
import type { Catalog } from "../catalog/catalog";
import { runSteps } from "./steps";
import { stepOverrides, type ServiceStep, type ServiceSteps } from "./definition";
import type { Invocation, InvokeValue, StreamInvocation, StreamValue } from "./outcome";
import type { ProgressRecorder } from "../observability/progressRecorder";
import type { ActiveRequestRegistry } from "../observability/activeRequests";

/** Shared dependencies every executor needs. */
export interface ServiceDeps {
  catalog: Catalog;
  transport: Transport;
  /** Optional active-request registry for real-time progress tracking. */
  progress?: ActiveRequestRegistry | null;
  /** Token rate (tokens/second) for simulated/fabricated streams. Default 2000. */
  simulatedStreamingTokenRate?: number;
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
    return request.withOverrides(stepOverrides(step)).withOverrides(overrides);
  }

  async invoke(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<Invocation> {
    const prog = opts.progress ?? null;
    const { result, path } = await runSteps<InvokeValue>(this.def, async (step, stepIndex) => {
      prog?.record("llm", "step.start", `step ${stepIndex + 1}: ${step.model}@${step.provider} attempt starting`);
      const res = this.deps.catalog.resolve(step.model, step.provider);
      if (!res.ok) {
        prog?.record("error", "step.resolve", `mapping ${step.model}@${step.provider}: ${res.error}`);
        return { ok: false, status: 0, kind: "error", message: `mapping ${step.model}@${step.provider}: ${res.error}` };
      }
      const t = res.target;
      const merged = this.merge(request, step, overrides);
      const egress = buildRequest(t.family, merged.data());
      const target: SendTarget = {
        upstreamModel: t.upstreamModel,
        url: t.url,
        headers: t.headers,
        providerMaxOutputTokens: t.providerMaxOutputTokens,
        timeoutMs: opts.timeoutMs ?? this.def.timeoutMs,
        signal: opts.signal,
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
        },
      };
    }, { progress: prog });
    return { result, attemptPath: path, attempts: path.length };
  }

  /** Wrap a buffered invocation as a fabricated (paced) client stream. Shared by
   * reliable-streaming Model Services and Micro Agents (which always buffer).
   * The pacing rate is configurable via ServiceDeps.simulatedStreamingTokenRate.
   * `startedAt` is when the run began, so the upstream time (retries included)
   * counts against the pacing budget instead of being added to it. */
  protected fabricated(inv: Invocation, startedAt?: number): StreamInvocation {
    if (!inv.result.ok) return { result: inv.result, attemptPath: inv.attemptPath, attempts: inv.attempts };
    const v = inv.result.value;
    const tokenRate = this.deps.simulatedStreamingTokenRate ?? 2000;
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
    if (this.def.reliableStreaming) {
      return this.fabricated(await this.invoke(request, overrides, opts), startedAt);
    }
    const { result, path } = await runSteps<StreamValue>(this.def, async (step, stepIndex) => {
      prog?.record("llm", "step.start", `stream step ${stepIndex + 1}: ${step.model}@${step.provider} attempt starting`);
      const res = this.deps.catalog.resolve(step.model, step.provider);
      if (!res.ok) {
        prog?.record("error", "step.resolve", `mapping ${step.model}@${step.provider}: ${res.error}`);
        return { ok: false, status: 0, kind: "error", message: `mapping ${step.model}@${step.provider}: ${res.error}` };
      }
      const t = res.target;
      const merged = this.merge(request, step, overrides);
      const egress = buildRequest(t.family, merged.data());
      const target: SendTarget = {
        upstreamModel: t.upstreamModel,
        url: t.url,
        headers: t.headers,
        providerMaxOutputTokens: t.providerMaxOutputTokens,
        timeoutMs: opts.timeoutMs ?? this.def.timeoutMs,
        signal: opts.signal,
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
    }, { progress: prog });
    return { result, attemptPath: path, attempts: path.length };
  }
}
