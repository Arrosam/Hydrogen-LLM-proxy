import { ModelService, type InvokeOptions, type ServiceDeps } from "./modelService";
import { mergeOverrides, type RequestOverrides } from "../core/ir/params";
import type { Request } from "../core/ir/request";
import type { Response } from "../core/ir/response";
import { buildResponse } from "../core/format/registry";
import { textOf, type ImagePart } from "../core/ir/content";
import { addUsage, ZERO_USAGE, type Usage } from "../core/ir/usage";
import { serializeForLog } from "../util/logPayload";
import { stageOverrides, type AgentDef, type ServiceSteps } from "./definition";
import { audioHash, transcribeAudio } from "./asr";
import {
  buildOcrRequest,
  buildStageRequest,
  collectImages,
  inputContext,
  nextStep,
  parseOcrResults,
  translateImagesInRequest,
  collectAudio,
  translateAudioInRequest,
} from "./agentContext";
import { imageHash, type OcrCacheStore } from "./ocrCache";
import type { AttemptFailure, AttemptRecord, AttemptResult } from "./steps";
import { failureMessage } from "../core/proxy/errors";
import type { Invocation, InvokeValue, StreamInvocation } from "./outcome";
import type { ProgressRecorder } from "../observability/progressRecorder";

/** How deep nested Micro Agents may reference one another before we stop. */
const MAX_AGENT_DEPTH = 8;

/** Resolves a saved service name to a runnable executor (Model Service or nested agent). */
export type ResolveResult =
  | { ok: true; executor: ModelService; isAgent: boolean }
  | { ok: false; message: string };

export interface ServiceResolver {
  /** Resolve an stt-category service's raw step chain for the ASR pre-pass. */
  sttDef(name: string): { ok: true; def: ServiceSteps } | { ok: false; message: string };
  resolve(name: string): ResolveResult;
}

export interface MicroAgentDeps extends ServiceDeps {
  resolver: ServiceResolver;
  logMaxChars: number | (() => number);
  /** Cache for the OCR pre-pass. Omitted/null = every image goes to the model. */
  ocrCache?: OcrCacheStore | null;
}

/**
 * One Model Service invocation a Micro Agent made -- one per stage, the OCR
 * pre-pass, or a nested Micro Agent. Mirrors a top-level request log: the called
 * service, its own attempt path, request/response payloads, status, latency,
 * usage. A nested Micro Agent is one call whose `calls` holds what IT called.
 */
export interface ServiceCall {
  stage: string;
  service: string;
  kind: "service" | "agent" | "router";
  status: number;
  latencyMs: number;
  usage?: Usage;
  attempts: AttemptRecord[];
  request?: string;
  response?: string;
  error?: string;
  calls?: ServiceCall[];
  streamed?: boolean;
}

/** Total upstream attempts across a call log (incl. nested Micro Agents). */
export function countAttempts(calls: ServiceCall[]): number {
  let n = 0;
  for (const c of calls) {
    n += c.attempts.length;
    if (c.calls) n += countAttempts(c.calls);
  }
  return n;
}

function withoutSystem(o?: RequestOverrides): RequestOverrides | undefined {
  if (!o || o.system === undefined) return o;
  const { system, ...rest } = o;
  void system;
  return rest;
}

function isRouter(stage: AgentDef["stages"][number]): boolean {
  return !stage.service && (!stage.steps || stage.steps.length === 0);
}

/**
 * A Micro Agent: a coordinator that runs multiple Model Service rounds (stages)
 * and presents itself AS a Model Service (extends {@link ModelService}), so it
 * is substitutable wherever a Model Service is expected and can be nested inside
 * another Micro Agent. All of its internal calls are buffered — routing
 * conditions need each stage's full output — but the WIRE MODE of each call
 * inherits the client's streaming preference: a streaming client gets streaming
 * upstream calls, collected locally (with truncation detection); a
 * non-streaming client gets plain JSON calls. For a streaming client the whole
 * run is buffered, then replayed as a paced stream.
 */
export class MicroAgent extends ModelService {
  private readonly resolver: ServiceResolver;
  private readonly logMaxChars: number | (() => number);
  private readonly ocrCache: OcrCacheStore | null;

  constructor(
    private readonly agent: AgentDef,
    deps: MicroAgentDeps,
  ) {
    // The base holds a placeholder step chain; a Micro Agent overrides invoke()/
    // stream() and never runs the base step loop.
    super({ timeoutMs: agent.timeoutMs, steps: [] }, deps);
    this.resolver = deps.resolver;
    this.logMaxChars = deps.logMaxChars;
    this.ocrCache = deps.ocrCache ?? null;
  }

  /** Resolve the (possibly live) log-payload max-chars to a concrete number. */
  private resolveLogMaxChars(): number {
    const v = this.logMaxChars;
    return typeof v === "function" ? v() : v;
  }

  /** A Micro Agent always buffers, then replays the complete result as a stream.
   * The pacing budget starts here, so the (often long) multi-stage run counts
   * against it rather than being added to it. */
  async stream(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<StreamInvocation> {
    const startedAt = Date.now();
    return this.fabricated(await this.invoke(request, overrides, opts), startedAt);
  }

  async invoke(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<Invocation> {
    const agent = this.agent;
    const stack = opts.stack ?? [];
    const prog = opts.progress ?? null;
    prog?.record("agent", "agent.init", `micro agent initialized: ${agent.stages.length} stage(s)`, { stages: agent.stages.map((s) => s.name) });
    const byName = new Map(agent.stages.map((s, i) => [s.name, i]));
    const outputs = new Map<string, string>();
    const values = new Map<string, InvokeValue>();
    const responses = new Map<string, Response>();
    const calls: ServiceCall[] = [];
    let usage: Usage = ZERO_USAGE;
    let lastValue: InvokeValue | null = null;
    let terminal = agent.stages[0]?.name ?? "";
    let returnStage: string | undefined = agent.output;

    const fail = (result: AttemptFailure): Invocation => ({ result, attemptPath: calls, attempts: countAttempts(calls) });
    const errorInv = (message: string): Invocation => fail({ ok: false, status: 0, kind: "error", message });
    const commit = (name: string, value: InvokeValue): void => {
      outputs.set(name, textOf(value.response.content));
      values.set(name, value);
      responses.set(name, value.response);
      lastValue = value;
      usage = addUsage(usage, value.response.usage);
    };

    try {
      let source = request;

      // --- OCR pre-pass -----------------------------------------------------
      if (agent.ocr) {
        const images = collectImages(request);
        if (images.length > 0) {
          const ocr = agent.ocr;
          // Resolve the OCR model BEFORE consulting the cache: a broken
          // reference must fail the same way whether or not the images happen
          // to be cached, or a misconfigured agent looks healthy until the
          // cache turns over.
          let ocrService: ModelService;
          if (ocr.service) {
            const r = this.resolver.resolve(ocr.service);
            if (!r.ok) return errorInv(r.message);
            if (r.isAgent) return errorInv(`OCR reference "${ocr.service}" must be a Model Service, not a Micro Agent`);
            ocrService = r.executor;
          } else if (ocr.steps && ocr.steps.length) {
            ocrService = new ModelService({ timeoutMs: ocr.timeoutMs ?? agent.timeoutMs, steps: ocr.steps }, this.deps);
          } else {
            return errorInv("image translation (OCR) is enabled but has no model configured");
          }

          // Content-addressed cache: a picture already transcribed is not sent
          // to the model again. Positions are kept in `hashes` so the results
          // land back on the right images, whatever their cache status.
          const hashes = images.map(imageHash);
          const cache = this.ocrCache;
          const known = cache ? cache.lookup(hashes) : new Map<string, string>();

          // Misses, de-duplicated: the same image pasted twice is one job.
          const pending: Array<{ hash: string; image: ImagePart }> = [];
          const queued = new Set<string>();
          images.forEach((image, i) => {
            const hash = hashes[i];
            if (known.has(hash) || queued.has(hash)) return;
            queued.add(hash);
            pending.push({ hash, image });
          });

          const hits = [...known.keys()];
          prog?.record(
            "agent",
            "agent.ocr.start",
            `OCR pre-pass: ${images.length} image(s) detected, ${images.length - pending.length} from cache, ${pending.length} to transcribe`,
            { images: images.length, cached: images.length - pending.length, pending: pending.length },
          );

          const byHash = new Map(known);
          if (pending.length > 0) {
            const ocrReq = buildOcrRequest(request, pending.map((p) => p.image), ocr);
            const { call, result } = await this.callService(ocrService, ocrReq, undefined, { stage: "(ocr)", service: ocr.service }, opts.signal, ocr.timeoutMs, prog);
            calls.push(call);
            if (!result.ok) {
              prog?.record("error", "agent.ocr.fail", `OCR pre-pass failed: ${result.message}`);
              return fail(result);
            }
            usage = addUsage(usage, result.value.response.usage);
            const fresh = parseOcrResults(result.value.response.text(), pending.length);
            fresh.forEach((description, i) => byHash.set(pending[i].hash, description));
            // Only what the model actually produced is remembered: caching an
            // empty result would make one bad response that image's permanent
            // description.
            cache?.store(
              pending
                .map((p, i) => ({ hash: p.hash, description: fresh[i] ?? "" }))
                .filter((e) => e.description.trim() !== ""),
            );
          }
          // Re-stamp the hits only once the pre-pass actually succeeded, so a
          // failed run does not extend the life of entries it never used.
          if (hits.length > 0) cache?.touch(hits);

          source = translateImagesInRequest(request, hashes.map((h) => byHash.get(h) ?? ""));
          prog?.record("agent", "agent.ocr.done", pending.length === 0
            ? "OCR pre-pass complete, every image served from the cache"
            : "OCR pre-pass complete, images translated to text");
        }
      }

      // --- ASR pre-pass -----------------------------------------------------
      if (agent.asr) {
        const audios = collectAudio(source);
        if (audios.length > 0) {
          const asr = agent.asr;
          let asrDef: ServiceSteps;
          if (asr.service) {
            const r = this.resolver.sttDef(asr.service);
            if (!r.ok) return errorInv(r.message);
            asrDef = r.def;
          } else if (asr.steps && asr.steps.length) {
            asrDef = { timeoutMs: asr.timeoutMs ?? agent.timeoutMs, steps: asr.steps };
          } else {
            return errorInv("audio transcription (ASR) is enabled but has no model configured");
          }

          // Content-addressed cache, shared with OCR (hashes are "a:"-prefixed
          // so the two kinds can never collide).
          const hashes = audios.map(audioHash);
          const cache = this.ocrCache;
          const known = cache ? cache.lookup(hashes) : new Map<string, string>();
          const pending: Array<{ hash: string; index: number }> = [];
          const queued = new Set<string>();
          audios.forEach((_, i) => {
            const hash = hashes[i];
            if (known.has(hash) || queued.has(hash)) return;
            queued.add(hash);
            pending.push({ hash, index: i });
          });
          prog?.record("agent", "agent.asr.start",
            `ASR pre-pass: ${audios.length} audio attachment(s), ${audios.length - pending.length} from cache, ${pending.length} to transcribe`,
            { audios: audios.length, cached: audios.length - pending.length, pending: pending.length });

          const byHash = new Map(known);
          for (const job of pending) {
            const started = Date.now();
            const out = await transcribeAudio(asrDef, audios[job.index], this.deps, { timeoutMs: asr.timeoutMs, signal: opts.signal });
            calls.push({
              stage: "(asr)", service: asr.service ?? "(inline)", kind: "service",
              status: out.result.ok ? 200 : out.result.status, latencyMs: Date.now() - started,
              attempts: out.path, error: out.result.ok ? undefined : out.result.message,
            });
            if (!out.result.ok) {
              prog?.record("error", "agent.asr.fail", `ASR pre-pass failed: ${out.result.message}`);
              return fail(out.result);
            }
            if (out.result.value.trim() !== "") byHash.set(job.hash, out.result.value);
          }
          cache?.store(pending
            .map((j) => ({ hash: j.hash, description: byHash.get(j.hash) ?? "" }))
            .filter((e) => e.description.trim() !== ""));
          const hits = [...known.keys()];
          if (hits.length > 0) cache?.touch(hits);

          source = translateAudioInRequest(source, hashes.map((h) => byHash.get(h) ?? ""));
          prog?.record("agent", "agent.asr.done", pending.length === 0
            ? "ASR pre-pass complete, every attachment served from the cache"
            : "ASR pre-pass complete, audio transcribed to text");
        }
      }

      // --- stage loop -------------------------------------------------------
      const input = inputContext(source);
      let idx = 0;
      while (idx >= 0 && idx < agent.stages.length) {
        const stage = agent.stages[idx];
        terminal = stage.name;
        prog?.record("agent", "agent.stage.start", `stage "${stage.name}" starting (index ${idx})`, { stage: stage.name, index: idx });

        if (isRouter(stage)) {
          prog?.record("agent", "agent.stage.router", `stage "${stage.name}" is a router (no model call)`, { stage: stage.name });
          outputs.set(stage.name, "");
          calls.push({ stage: stage.name, service: "(router)", kind: "router", status: 200, latencyMs: 0, attempts: [] });
        } else {
          // Outer overrides fold over this stage's config, the outer winning.
          const combined = mergeOverrides(stageOverrides(stage), overrides);
          // Stages inherit the client's streaming preference: a streaming client
          // gets streaming upstream calls (collected locally — the stage still
          // consumes one complete output, and a truncated stream is a retryable
          // 502). Long generations then hold their upstream connections open
          // token by token instead of sitting silent behind one JSON response.
          const stageReq = buildStageRequest(source, stage, outputs, responses, source.stream, combined?.system);
          const childOverrides = withoutSystem(combined);

          if (stage.service) {
            const r = this.resolver.resolve(stage.service);
            if (!r.ok) {
              prog?.record("error", "agent.stage.resolve", `stage "${stage.name}": ${r.message}`);
              return errorInv(r.message);
            }

            if (r.isAgent) {
              if (stack.includes(stage.service)) {
                prog?.record("error", "agent.stage.cycle", `micro-agent cycle detected: "${stage.service}"`);
                return errorInv(`micro-agent cycle detected: "${stage.service}" is already running`);
              }
              if (stack.length >= MAX_AGENT_DEPTH) {
                prog?.record("error", "agent.stage.depth", `micro-agent nesting too deep (>${MAX_AGENT_DEPTH})`);
                return errorInv(`micro-agent nesting too deep (>${MAX_AGENT_DEPTH})`);
              }
              prog?.record("agent", "agent.stage.nested", `stage "${stage.name}": invoking nested agent "${stage.service}"`, { stage: stage.name, service: stage.service });
              const started = Date.now();
              const wrapper: ServiceCall = { stage: stage.name, service: stage.service, kind: "agent", status: 0, latencyMs: 0, attempts: [], request: this.stageRequestPayload(stageReq), calls: [] };
              const sub = await r.executor.invoke(stageReq, childOverrides, { stack: [...stack, stage.service], signal: opts.signal, timeoutMs: stage.timeoutMs, progress: prog });
              wrapper.calls = sub.attemptPath as ServiceCall[];
              wrapper.latencyMs = Date.now() - started;
              calls.push(wrapper);
              if (!sub.result.ok) {
                wrapper.status = sub.result.status;
                wrapper.error = sub.result.message;
                prog?.record("agent", "agent.stage.fail", `stage "${stage.name}" (nested agent) failed: ${sub.result.message}`, { stage: stage.name, status: sub.result.status });
                return fail(sub.result);
              }
              wrapper.status = 200;
              wrapper.usage = sub.result.value.response.usage;
              wrapper.response = this.stageResponsePayload(sub.result.value.response);
              commit(stage.name, sub.result.value);
              prog?.record("agent", "agent.stage.done", `stage "${stage.name}" (nested agent) completed`, { stage: stage.name, latencyMs: wrapper.latencyMs });
            } else {
              prog?.record("agent", "agent.stage.call", `stage "${stage.name}": calling service "${stage.service}"`, { stage: stage.name, service: stage.service });
              const { call, result } = await this.callService(r.executor, stageReq, childOverrides, { stage: stage.name, service: stage.service }, opts.signal, stage.timeoutMs, prog);
              calls.push(call);
              if (!result.ok) {
                prog?.record("agent", "agent.stage.fail", `stage "${stage.name}" failed: ${result.message}`, { stage: stage.name, status: result.status });
                return fail(result);
              }
              commit(stage.name, result.value);
              prog?.record("agent", "agent.stage.done", `stage "${stage.name}" completed`, { stage: stage.name, latencyMs: call.latencyMs });
            }
          } else if (stage.steps && stage.steps.length) {
            prog?.record("agent", "agent.stage.call", `stage "${stage.name}": calling inline steps`, { stage: stage.name });
            const anon = new ModelService({ timeoutMs: stage.timeoutMs ?? agent.timeoutMs, steps: stage.steps }, this.deps);
            const { call, result } = await this.callService(anon, stageReq, childOverrides, { stage: stage.name }, opts.signal, stage.timeoutMs, prog);
            calls.push(call);
            if (!result.ok) {
              prog?.record("agent", "agent.stage.fail", `stage "${stage.name}" (inline) failed: ${result.message}`, { stage: stage.name, status: result.status });
              return fail(result);
            }
            commit(stage.name, result.value);
            prog?.record("agent", "agent.stage.done", `stage "${stage.name}" (inline) completed`, { stage: stage.name, latencyMs: call.latencyMs });
          } else {
            prog?.record("error", "agent.stage.empty", `stage "${stage.name}" has no Model Service or steps`);
            return errorInv(`stage "${stage.name}" has no Model Service or steps`);
          }
        }

        const step = nextStep(stage, idx, byName, input, outputs);
        if ("end" in step) {
          if (step.output) returnStage = step.output;
          prog?.record("agent", "agent.stage.end", `agent ending at stage "${stage.name}"${step.output ? `, returning output of "${step.output}"` : ""}`, { terminal: stage.name, output: step.output });
          break;
        }
        idx = step.index;
      }

      const chosen = (returnStage ? values.get(returnStage) : undefined) ?? values.get(terminal) ?? lastValue;
      if (!chosen) {
        prog?.record("error", "agent.nooutput", "agent produced no model output");
        return errorInv("agent produced no model output");
      }
      // Report the agent's total usage across all stages on the returned response.
      const response = buildResponse(chosen.family, { ...chosen.response.data(), usage });
      const value: InvokeValue = { ...chosen, response };
      prog?.record("agent", "agent.complete", `micro agent completed: ${calls.length} call(s), ${usage.totalTokens} tokens`, { calls: calls.length, totalTokens: usage.totalTokens });
      return { result: { ok: true, value }, attemptPath: calls, attempts: countAttempts(calls) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      prog?.record("error", "agent.exception", `agent execution error: ${message}`);
      return errorInv(`agent execution error: ${message}`);
    }
  }

  /** Invoke a child Model Service (buffered) and record it as one ServiceCall. */
  private async callService(
    service: ModelService,
    stageReq: Request,
    overrides: RequestOverrides | undefined,
    meta: { stage: string; service?: string },
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    prog: ProgressRecorder | null = null,
  ): Promise<{ call: ServiceCall; result: AttemptResult<InvokeValue> }> {
    const started = Date.now();
    const inv = await service.invoke(stageReq, overrides, { signal, timeoutMs, progress: prog });
    const path = inv.attemptPath as AttemptRecord[];
    const call: ServiceCall = {
      stage: meta.stage,
      service: meta.service ?? "(inline)",
      kind: "service",
      status: inv.result.ok ? 200 : inv.result.status,
      latencyMs: Date.now() - started,
      attempts: path,
      request: inv.result.ok ? serializeForLog(inv.result.value.upstreamRequest, this.resolveLogMaxChars()) : this.stageRequestPayload(stageReq),
    };
    if (inv.result.ok) {
      call.usage = inv.result.value.response.usage;
      call.response = this.stageResponsePayload(inv.result.value.response);
    } else {
      call.error = failureMessage(inv.result);
    }
    return { call, result: inv.result };
  }

  private stageRequestPayload(stageReq: Request): string {
    return serializeForLog(
      {
        system: stageReq.system,
        messages: stageReq.messages,
        tools: stageReq.tools,
        tool_choice: stageReq.toolChoice,
        params: stageReq.params,
      },
      this.resolveLogMaxChars(),
    );
  }

  private stageResponsePayload(response: Response): string {
    return serializeForLog(response.toLogPayload(), this.resolveLogMaxChars());
  }
}
