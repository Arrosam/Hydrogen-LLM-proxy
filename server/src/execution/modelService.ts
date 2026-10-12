import { buildRequest } from "../core/format/registry";
import type { Family, RequestOverrides } from "../core/ir/params";
import type { Request } from "../core/ir/request";
import { inlineUrlFiles, needsUrlFileInlining } from "./fileFetch";
import { fabricateStream } from "../core/ir/stream";
import type { SendTarget, Transport } from "../core/upstream/transport";
import { mappingErrorMessage, type Catalog } from "../catalog/catalog";
import { runSteps, type AttemptFailure } from "./steps";
import { stepOverrides, type ServiceStep, type ServiceSteps } from "./definition";
import type { Invocation, InvokeValue, StreamInvocation, StreamValue } from "./outcome";
import type { ProgressRecorder } from "../observability/progressRecorder";
import type { ActiveRequestRegistry } from "../observability/activeRequests";
import { DEFAULT_PROMPT_CACHE_TTL_MINUTES, DEFAULT_SIMULATED_STREAMING_TOKEN_RATE } from "../config/defaults";
import { HTTP_STATUS } from "../util/httpStatus";

/** Live-progress node ids recorded while a step runs. */
const PROGRESS_NODE = {
  STEP_START: "step.start",
  STEP_RESOLVE: "step.resolve",
  LLM_FILES: "llm.files",
  LLM_SERIALIZE: "llm.serialize",
  LLM_SEND: "llm.send",
  LLM_RECEIVE: "llm.receive",
  LLM_RESULT: "llm.result",
} as const;

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

/** Resolve a possibly-live token rate (number | getter). Default 2000. */
function resolveRate(r: number | (() => number) | undefined): number {
  if (r == null) return DEFAULT_SIMULATED_STREAMING_TOKEN_RATE;
  return typeof r === "function" ? r() : r;
}

/** The progress wording that distinguishes a buffered attempt from a relayed one. */
interface AttemptLabels {
  step: string;
  serializeSuffix: string;
  send: string;
}
const BUFFERED_LABELS: AttemptLabels = { step: "step", serializeSuffix: "", send: "request initiated" };
const STREAM_LABELS: AttemptLabels = { step: "stream step", serializeSuffix: " (streaming)", send: "stream request initiated" };

type ResolvedTarget = Extract<ReturnType<Catalog["resolve"]>, { ok: true }>["target"];

/** A step that resolved and serialised: ready to send or relay. */
interface PreparedAttempt {
  ok: true;
  t: ResolvedTarget;
  merged: Request;
  egress: Request;
  target: SendTarget;
}

/** Who served a value: the identity fields every success value carries. */
type ServedBy = Pick<InvokeValue, "family" | "upstreamModel" | "providerName" | "modelName">;
function servedBy(t: ServedBy): ServedBy {
  return { family: t.family, upstreamModel: t.upstreamModel, providerName: t.providerName, modelName: t.modelName };
}

/** Record and return the failure of an upstream send/relay. */
function upstreamFailure(
  prog: ProgressRecorder | null,
  sent: { status: number; kind: AttemptFailure["kind"]; message: string; body?: unknown },
): AttemptFailure {
  prog?.record("llm", PROGRESS_NODE.LLM_RECEIVE, `upstream returned ${sent.status}: ${sent.message}`, { status: sent.status });
  return { ok: false, status: sent.status, kind: sent.kind, message: sent.message, errorBody: sent.body };
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
}

export interface InvokeOptions {
  hosted?: import("./hostedToolLoop").HostedContext;
  /** Aborts the upstream call (client disconnect). */
  signal?: AbortSignal;
  /** Override the step-chain timeout (an agent stage may set its own). */
  timeoutMs?: number;
  /** Names of the agents currently on the call stack (nested-agent cycle guard). */
  stack?: string[];
  /** Progress recorder for emitting real-time events (null = no tracking). */
  progress?: ProgressRecorder | null;
  /** Aggregate URL-attachment budget (bytes) inherited from an enclosing agent. */
  maxAttachmentBytes?: number;
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
      merged = merged.withOverrides({ cacheTtlMinutes: typeof ttl === "function" ? ttl() : ttl ?? DEFAULT_PROMPT_CACHE_TTL_MINUTES });
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
    opts: { timeoutMs: number; signal?: AbortSignal; maxTotalBytes?: number },
  ): Promise<Request> {
    if (!needsUrlFileInlining(merged, family)) return merged;
    prog?.record("llm", PROGRESS_NODE.LLM_FILES, `downloading URL attachment(s) to inline for ${family}`, { family });
    return inlineUrlFiles(merged, family, this.deps.transport, opts);
  }

  /** Everything an attempt does before it reaches the upstream, identical for
   * the buffered and the relayed path: resolve the step's mapping, layer the
   * overrides, inline what the egress family cannot carry, and serialise.
   * Only the progress wording differs (`labels`). */
  private async prepareAttempt(
    request: Request,
    step: ServiceStep,
    stepIndex: number,
    overrides: RequestOverrides | undefined,
    opts: InvokeOptions,
    labels: AttemptLabels,
  ): Promise<PreparedAttempt | AttemptFailure> {
    const prog = opts.progress ?? null;
    prog?.record("llm", PROGRESS_NODE.STEP_START, `${labels.step} ${stepIndex + 1}: ${step.model}@${step.provider} attempt starting`);
    const res = this.deps.catalog.resolve(step.model, step.provider, request.family);
    if (!res.ok) {
      const message = mappingErrorMessage(step.model, step.provider, res.error);
      prog?.record("error", PROGRESS_NODE.STEP_RESOLVE, message);
      return { ok: false, status: 0, kind: "error", message };
    }
    const t = res.target;
    const merged = this.merge(request, step, overrides);
    const timeoutMs = opts.timeoutMs ?? this.def.timeoutMs;
    // A URL attachment this family cannot carry is downloaded and inlined
    // first (see fileFetch). Resolved per step, because the very same request
    // needs no pre-pass at all on a family that takes URLs natively.
    const ready = await this.inlineFiles(merged, t.family, prog, {
      timeoutMs,
      signal: opts.signal,
      maxTotalBytes: opts.maxAttachmentBytes ?? this.def.maxAttachmentBytes,
    });
    const egress = buildRequest(t.family, ready.data());
    prog?.record("llm", PROGRESS_NODE.LLM_SERIALIZE, `parameters serialized for ${t.family} -> ${t.upstreamModel}${labels.serializeSuffix}`, { family: t.family, model: t.upstreamModel });
    prog?.record("llm", PROGRESS_NODE.LLM_SEND, `${labels.send} to ${t.upstreamModel} (${t.providerName})`, { model: t.upstreamModel, provider: t.providerName, url: t.url });
    const target: SendTarget = {
      upstreamModel: t.upstreamModel,
      url: t.url,
      headers: mergeForwardHeaders(t.headers, merged.params.forwardHeaders, t.family),
      providerMaxOutputTokens: t.providerMaxOutputTokens,
      timeoutMs,
      signal: opts.signal,
      proxy: t.upstream.proxy,
    };
    return { ok: true, t, merged, egress, target };
  }

  async invoke(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<Invocation> {
    const prog = opts.progress ?? null;
    const { result, path } = await runSteps<InvokeValue>(this.def, async (step, stepIndex) => {
      const attempt = await this.prepareAttempt(request, step, stepIndex, overrides, opts, BUFFERED_LABELS);
      if (!attempt.ok) return attempt;
      const { t, merged } = attempt;
      const sent = await attempt.egress.send(this.deps.transport, attempt.target);
      if (!sent.ok) return upstreamFailure(prog, sent);
      prog?.record("llm", PROGRESS_NODE.LLM_RECEIVE, `response generated and received from ${t.upstreamModel}`, { status: HTTP_STATUS.OK });
      prog?.record("llm", PROGRESS_NODE.LLM_RESULT, `result parsed and ready for return`, { model: t.upstreamModel });
      // Honor a "disabled" thinking level end-to-end even if the upstream ignored it.
      let response = sent.response;
      if (merged.params.thinking === "disabled") response = response.withoutReasoning();
      return { ok: true, value: { response, ...servedBy(t), upstreamRequest: sent.sentBody } };
    }, { progress: prog, signal: opts.signal });
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
    const tokenRate = resolveRate(this.deps.simulatedStreamingTokenRate);
    return {
      result: {
        ok: true,
        value: {
          events: fabricateStream(v.response.data(), tokenRate, startedAt),
          ...servedBy(v),
          upstreamRequest: v.upstreamRequest,
          // Reasoning was already stripped in invoke() if the level was disabled.
          dropReasoning: false,
        },
      },
      attemptPath: inv.attemptPath,
      attempts: inv.attempts,
    };
  }

  /** Run buffered, then replay the complete result as a paced stream. The
   * pacing budget starts before the run, so the run itself (retries, or an
   * agent's many stages) counts against it rather than being added to it. */
  protected async bufferedStream(request: Request, overrides: RequestOverrides | undefined, opts: InvokeOptions): Promise<StreamInvocation> {
    const startedAt = Date.now();
    return this.fabricated(await this.invoke(request, overrides, opts), startedAt);
  }

  async stream(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<StreamInvocation> {
    const prog = opts.progress ?? null;
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
    if (this.def.reliableStreaming) return this.bufferedStream(request, overrides, opts);
    const { result, path } = await runSteps<StreamValue>(this.def, async (step, stepIndex) => {
      const attempt = await this.prepareAttempt(request, step, stepIndex, overrides, opts, STREAM_LABELS);
      if (!attempt.ok) return attempt;
      const { t, merged } = attempt;
      const sent = await attempt.egress.relay(this.deps.transport, attempt.target);
      if (!sent.ok) return upstreamFailure(prog, sent);
      prog?.record("llm", PROGRESS_NODE.LLM_RECEIVE, `stream committed from ${t.upstreamModel} (headers received)`, { status: sent.status });
      prog?.record("llm", PROGRESS_NODE.LLM_RESULT, `stream events ready for relay`, { model: t.upstreamModel });
      return {
        ok: true,
        value: {
          events: sent.events,
          ...servedBy(t),
          upstreamRequest: sent.sentBody,
          dropReasoning: merged.params.thinking === "disabled",
        },
      };
    }, { progress: prog, signal: opts.signal });
    return { result, attemptPath: path, attempts: path.length };
  }
}
