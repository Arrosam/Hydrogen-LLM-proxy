import { ModelService, type InvokeOptions, type ServiceDeps } from "./modelService";
import { mergeOverrides, type RequestOverrides } from "../core/ir/params";
import type { Request } from "../core/ir/request";
import type { Response } from "../core/ir/response";
import { buildResponse } from "../core/format/registry";
import { textOf, type ImagePart } from "../core/ir/content";
import { addUsage, ZERO_USAGE, type Usage } from "../core/ir/usage";
import { CALL_LABEL, callService, countAttempts, requestPayload, responsePayload, type ServiceCall } from "./serviceCall";
import { isRouterStage, stageOverrides, type AgentDef, type ServiceSteps } from "./definition";
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
import { refOrInline, runCachedPrePass, type PrePassLabels } from "./prePass";
import type { AttemptFailure } from "./steps";
import type { Invocation, InvokeValue, StreamInvocation } from "./outcome";
import { BYTES_PER_MIB } from "../config/limits";
import { HTTP_STATUS } from "../util/httpStatus";
import { errorMessage } from "../util/errors";

/** Live-progress node ids recorded while an agent runs. */
const PROGRESS_NODE = {
  AGENT_INIT: "agent.init",
  AGENT_OCR_START: "agent.ocr.start",
  AGENT_OCR_FAIL: "agent.ocr.fail",
  AGENT_OCR_DONE: "agent.ocr.done",
  AGENT_ASR_START: "agent.asr.start",
  AGENT_ASR_FAIL: "agent.asr.fail",
  AGENT_ASR_DONE: "agent.asr.done",
  AGENT_STAGE_START: "agent.stage.start",
  AGENT_STAGE_ROUTER: "agent.stage.router",
  AGENT_STAGE_RESOLVE: "agent.stage.resolve",
  AGENT_STAGE_CYCLE: "agent.stage.cycle",
  AGENT_STAGE_DEPTH: "agent.stage.depth",
  AGENT_STAGE_NESTED: "agent.stage.nested",
  AGENT_STAGE_FAIL: "agent.stage.fail",
  AGENT_STAGE_DONE: "agent.stage.done",
  AGENT_STAGE_CALL: "agent.stage.call",
  AGENT_STAGE_EMPTY: "agent.stage.empty",
  AGENT_STAGE_END: "agent.stage.end",
  AGENT_NOOUTPUT: "agent.nooutput",
  AGENT_COMPLETE: "agent.complete",
  AGENT_EXCEPTION: "agent.exception",
} as const;

const OCR_LABELS: PrePassLabels = {
  startNode: PROGRESS_NODE.AGENT_OCR_START,
  doneNode: PROGRESS_NODE.AGENT_OCR_DONE,
  countKey: "images",
  start: (total, cached, pending) => `OCR pre-pass: ${total} image(s) detected, ${cached} from cache, ${pending} to transcribe`,
  doneCached: "OCR pre-pass complete, every image served from the cache",
  doneFresh: "OCR pre-pass complete, images translated to text",
};
const ASR_LABELS: PrePassLabels = {
  startNode: PROGRESS_NODE.AGENT_ASR_START,
  doneNode: PROGRESS_NODE.AGENT_ASR_DONE,
  countKey: "audios",
  start: (total, cached, pending) => `ASR pre-pass: ${total} audio attachment(s), ${cached} from cache, ${pending} to transcribe`,
  doneCached: "ASR pre-pass complete, every attachment served from the cache",
  doneFresh: "ASR pre-pass complete, audio transcribed to text",
};

/** How deep nested Micro Agents may reference one another before we stop. */
const MAX_AGENT_DEPTH = 8;

/**
 * One OCR upstream call may carry at most this many images, and this many bytes
 * of image data.
 *
 * A stage request is rendered and serialized into a fresh wire body, and that
 * body is a complete second copy of the batch's base64. Sending every image in
 * a request as one call therefore makes the peak scale with the whole request
 * even though each image is transcribed independently -- the largest avoidable
 * allocation on the image path. Batching bounds the peak to one batch's worth,
 * and keeps a request under a provider's own per-request image cap.
 *
 * Both are deliberately generous: an ordinary request (a handful of images)
 * still makes exactly one call, so nothing changes for it.
 */
export const OCR_IMAGES_PER_CALL = 32;
export const OCR_BYTES_PER_CALL = 8 * BYTES_PER_MIB;

/** The image's contribution to a wire body: base64 characters, or a URL. */
function imageApproxBytes(img: ImagePart): number {
  return img.source.kind === "base64" ? img.source.data.length : img.source.url.length;
}

/** Split OCR work into bounded batches. An oversized single image is its own batch. */
export function batchImages<T extends { image: ImagePart }>(
  items: T[],
  maxCount: number = OCR_IMAGES_PER_CALL,
  maxBytes: number = OCR_BYTES_PER_CALL,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = imageApproxBytes(item.image);
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

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

function withoutSystem(o?: RequestOverrides): RequestOverrides | undefined {
  if (!o || o.system === undefined) return o;
  const { system, ...rest } = o;
  void system;
  return rest;
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

  /** A Micro Agent always buffers, then replays the complete result as a stream. */
  async stream(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<StreamInvocation> {
    return this.bufferedStream(request, overrides, opts);
  }

  async invoke(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<Invocation> {
    const agent = this.agent;
    const stack = opts.stack ?? [];
    const prog = opts.progress ?? null;
    const logMaxChars = (): number => this.resolveLogMaxChars();
    // A URL-attachment budget set on this agent bounds each call it makes; an
    // enclosing agent's budget is inherited when this one sets none.
    const attachmentLimit = this.agent.maxAttachmentBytes ?? opts.maxAttachmentBytes;
    prog?.record("agent", PROGRESS_NODE.AGENT_INIT, `micro agent initialized: ${agent.stages.length} stage(s)`, { stages: agent.stages.map((s) => s.name) });
    const byName = new Map(agent.stages.map((s, i) => [s.name, i]));
    const outputs = new Map<string, string>();
    const values = new Map<string, InvokeValue>();
    const responses = new Map<string, Response>();
    const calls: ServiceCall[] = [];
    let usage: Usage = ZERO_USAGE;
    let lastValue: InvokeValue | null = null;
    // The full rendered wire body of the LAST stage only. A stage's body is a
    // complete copy of the conversation -- for an image request, another copy of
    // every base64 image -- and holding one per stage is what turns a single
    // request into N copies in memory. Nothing downstream reads a stage's body
    // except the final log line, and each stage already keeps a size-bounded
    // copy of its own for the attempt log (see serviceCall.ts).
    let lastUpstreamRequest: Record<string, unknown> = {};
    let terminal = agent.stages[0]?.name ?? "";
    let returnStage: string | undefined = agent.output;

    const fail = (result: AttemptFailure): Invocation => ({ result, attemptPath: calls, attempts: countAttempts(calls), usage: calls.reduce((sum, call) => addUsage(sum, call.usage ?? ZERO_USAGE), ZERO_USAGE) });
    const errorInv = (message: string): Invocation => fail({ ok: false, status: 0, kind: "error", message });
    const commit = (name: string, value: InvokeValue): void => {
      outputs.set(name, textOf(value.response.content));
      // Store only what a later stage or the final response needs (the response
      // and the small identity fields) and drop the full wire body, so it is
      // collectible as soon as the next stage begins.
      const stored: InvokeValue = { ...value, upstreamRequest: {} };
      values.set(name, stored);
      responses.set(name, value.response);
      lastUpstreamRequest = value.upstreamRequest;
      lastValue = stored;
      usage = addUsage(usage, value.response.usage);
    };

    /** Invoke a child Model Service (buffered) and record it as one ServiceCall. */
    const callChild = (
      service: ModelService,
      stageReq: Request,
      childOverrides: RequestOverrides | undefined,
      meta: { stage: string; service?: string },
      timeoutMs: number | undefined,
    ) => callService(service, stageReq, childOverrides, meta, { signal: opts.signal, timeoutMs, progress: prog, hosted: opts.hosted, maxAttachmentBytes: attachmentLimit }, logMaxChars);
    /** Run a stage on a Model Service -- the saved one named `service`, or the
     * stage's inline steps when there is none -- and commit its output.
     * Returns the failed invocation, or null. */
    const runStage = async (
      stage: AgentDef["stages"][number],
      executor: ModelService,
      stageReq: Request,
      childOverrides: RequestOverrides | undefined,
      service?: string,
    ): Promise<Invocation | null> => {
      const label = service === undefined ? " (inline)" : "";
      const { call, result } = await callChild(executor, stageReq, childOverrides, { stage: stage.name, service }, stage.timeoutMs);
      calls.push(call);
      if (!result.ok) {
        prog?.record("agent", PROGRESS_NODE.AGENT_STAGE_FAIL, `stage "${stage.name}"${label} failed: ${result.message}`, { stage: stage.name, status: result.status });
        return fail(result);
      }
      commit(stage.name, result.value);
      prog?.record("agent", PROGRESS_NODE.AGENT_STAGE_DONE, `stage "${stage.name}"${label} completed`, { stage: stage.name, latencyMs: call.latencyMs });
      return null;
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
          const ocrService = refOrInline<ModelService>(
            ocr,
            (name) => {
              const r = this.resolver.resolve(name);
              if (!r.ok) return r;
              if (r.isAgent) return { ok: false, message: `OCR reference "${name}" must be a Model Service, not a Micro Agent` };
              return { ok: true, value: r.executor };
            },
            (steps) => new ModelService({ timeoutMs: ocr.timeoutMs ?? agent.timeoutMs, steps }, this.deps),
            "image translation (OCR) is enabled but has no model configured",
          );
          if (!ocrService.ok) return errorInv(ocrService.message);

          const pass = await runCachedPrePass({
            items: images,
            hash: imageHash,
            cache: this.ocrCache,
            signal: opts.signal,
            storeWhenIdle: false,
            progress: prog,
            labels: OCR_LABELS,
            transcribe: async (pending, texts) => {
              // One call per bounded batch, not one for every image in the request
              // (see OCR_IMAGES_PER_CALL): a smaller wire body per call is the
              // whole point, and positions are tracked per batch so results still
              // land on the right images.
              for (const batch of batchImages(pending.map((p) => ({ hash: p.hash, image: p.item })))) {
                const ocrReq = buildOcrRequest(request, batch.map((p) => p.image), ocr);
                const { call, result } = await callChild(ocrService.value, ocrReq, undefined, { stage: CALL_LABEL.OCR, service: ocr.service }, ocr.timeoutMs);
                calls.push(call);
                if (!result.ok) {
                  prog?.record("error", PROGRESS_NODE.AGENT_OCR_FAIL, `OCR pre-pass failed: ${result.message}`);
                  return result;
                }
                usage = addUsage(usage, result.value.response.usage);
                parseOcrResults(result.value.response.text(), batch.length).forEach((description, i) => texts.set(batch[i].hash, description));
              }
              return undefined;
            },
            rewrite: (texts) => translateImagesInRequest(request, texts),
          });
          if (!pass.ok) return fail(pass);
          source = pass.request;
        }
      }

      // --- ASR pre-pass -----------------------------------------------------
      if (agent.asr) {
        const audios = collectAudio(source);
        if (audios.length > 0) {
          const asr = agent.asr;
          const asrDef = refOrInline<ServiceSteps>(
            asr,
            (name) => {
              const r = this.resolver.sttDef(name);
              return r.ok ? { ok: true, value: r.def } : r;
            },
            (steps) => ({ timeoutMs: asr.timeoutMs ?? agent.timeoutMs, steps }),
            "audio transcription (ASR) is enabled but has no model configured",
          );
          if (!asrDef.ok) return errorInv(asrDef.message);

          // Content-addressed cache, shared with OCR (hashes are "a:"-prefixed
          // so the two kinds can never collide).
          const base = source;
          const pass = await runCachedPrePass({
            items: audios,
            hash: audioHash,
            cache: this.ocrCache,
            signal: opts.signal,
            storeWhenIdle: true,
            progress: prog,
            labels: ASR_LABELS,
            transcribe: async (pending, texts) => {
              for (const job of pending) {
                const started = Date.now();
                const out = await transcribeAudio(asrDef.value, job.item, this.deps, { timeoutMs: asr.timeoutMs, signal: opts.signal });
                calls.push({
                  stage: CALL_LABEL.ASR, service: asr.service ?? CALL_LABEL.INLINE, kind: "service",
                  status: out.result.ok ? HTTP_STATUS.OK : out.result.status, latencyMs: Date.now() - started,
                  attempts: out.path, error: out.result.ok ? undefined : out.result.message,
                });
                if (!out.result.ok) {
                  prog?.record("error", PROGRESS_NODE.AGENT_ASR_FAIL, `ASR pre-pass failed: ${out.result.message}`);
                  return out.result;
                }
                if (out.result.value.trim() !== "") texts.set(job.hash, out.result.value);
              }
              return undefined;
            },
            rewrite: (texts) => translateAudioInRequest(base, texts),
          });
          if (!pass.ok) return fail(pass);
          source = pass.request;
        }
      }

      // --- stage loop -------------------------------------------------------
      const input = inputContext(source);
      let idx = 0;
      while (idx >= 0 && idx < agent.stages.length) {
        const stage = agent.stages[idx];
        terminal = stage.name;
        prog?.record("agent", PROGRESS_NODE.AGENT_STAGE_START, `stage "${stage.name}" starting (index ${idx})`, { stage: stage.name, index: idx });

        if (isRouterStage(stage)) {
          prog?.record("agent", PROGRESS_NODE.AGENT_STAGE_ROUTER, `stage "${stage.name}" is a router (no model call)`, { stage: stage.name });
          outputs.set(stage.name, "");
          calls.push({ stage: stage.name, service: CALL_LABEL.ROUTER, kind: "router", status: HTTP_STATUS.OK, latencyMs: 0, attempts: [] });
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
              prog?.record("error", PROGRESS_NODE.AGENT_STAGE_RESOLVE, `stage "${stage.name}": ${r.message}`);
              return errorInv(r.message);
            }

            if (r.isAgent) {
              if (stack.includes(stage.service)) {
                prog?.record("error", PROGRESS_NODE.AGENT_STAGE_CYCLE, `micro-agent cycle detected: "${stage.service}"`);
                return errorInv(`micro-agent cycle detected: "${stage.service}" is already running`);
              }
              if (stack.length >= MAX_AGENT_DEPTH) {
                prog?.record("error", PROGRESS_NODE.AGENT_STAGE_DEPTH, `micro-agent nesting too deep (>${MAX_AGENT_DEPTH})`);
                return errorInv(`micro-agent nesting too deep (>${MAX_AGENT_DEPTH})`);
              }
              prog?.record("agent", PROGRESS_NODE.AGENT_STAGE_NESTED, `stage "${stage.name}": invoking nested agent "${stage.service}"`, { stage: stage.name, service: stage.service });
              const started = Date.now();
              const wrapper: ServiceCall = { stage: stage.name, service: stage.service, kind: "agent", status: 0, latencyMs: 0, attempts: [], request: requestPayload(stageReq, logMaxChars()), calls: [] };
              const sub = await r.executor.invoke(stageReq, childOverrides, { ...opts, stack: [...stack, stage.service], signal: opts.signal, timeoutMs: stage.timeoutMs, progress: prog, maxAttachmentBytes: attachmentLimit });
              wrapper.calls = sub.attemptPath as ServiceCall[];
              wrapper.latencyMs = Date.now() - started;
              calls.push(wrapper);
              if (!sub.result.ok) {
                wrapper.usage = sub.usage;
                wrapper.status = sub.result.status;
                wrapper.error = sub.result.message;
                prog?.record("agent", PROGRESS_NODE.AGENT_STAGE_FAIL, `stage "${stage.name}" (nested agent) failed: ${sub.result.message}`, { stage: stage.name, status: sub.result.status });
                return fail(sub.result);
              }
              wrapper.status = HTTP_STATUS.OK;
              wrapper.usage = sub.result.value.response.usage;
              wrapper.response = responsePayload(sub.result.value.response, logMaxChars());
              commit(stage.name, sub.result.value);
              prog?.record("agent", PROGRESS_NODE.AGENT_STAGE_DONE, `stage "${stage.name}" (nested agent) completed`, { stage: stage.name, latencyMs: wrapper.latencyMs });
            } else {
              prog?.record("agent", PROGRESS_NODE.AGENT_STAGE_CALL, `stage "${stage.name}": calling service "${stage.service}"`, { stage: stage.name, service: stage.service });
              const failed = await runStage(stage, r.executor, stageReq, childOverrides, stage.service);
              if (failed) return failed;
            }
          } else if (stage.steps && stage.steps.length) {
            prog?.record("agent", PROGRESS_NODE.AGENT_STAGE_CALL, `stage "${stage.name}": calling inline steps`, { stage: stage.name });
            const anon = new ModelService({ timeoutMs: stage.timeoutMs ?? agent.timeoutMs, steps: stage.steps }, this.deps);
            const failed = await runStage(stage, anon, stageReq, childOverrides);
            if (failed) return failed;
          } else {
            prog?.record("error", PROGRESS_NODE.AGENT_STAGE_EMPTY, `stage "${stage.name}" has no Model Service or steps`);
            return errorInv(`stage "${stage.name}" has no Model Service or steps`);
          }
        }

        const step = nextStep(stage, idx, byName, input, outputs);
        if ("end" in step) {
          if (step.output) returnStage = step.output;
          prog?.record("agent", PROGRESS_NODE.AGENT_STAGE_END, `agent ending at stage "${stage.name}"${step.output ? `, returning output of "${step.output}"` : ""}`, { terminal: stage.name, output: step.output });
          break;
        }
        idx = step.index;
      }

      const chosen = (returnStage ? values.get(returnStage) : undefined) ?? values.get(terminal) ?? lastValue;
      if (!chosen) {
        prog?.record("error", PROGRESS_NODE.AGENT_NOOUTPUT, "agent produced no model output");
        return errorInv("agent produced no model output");
      }
      // Report the agent's total usage across all stages on the returned response.
      const response = buildResponse(chosen.family, { ...chosen.response.data(), usage });
      // Carry the last stage's wire body for the request log; the per-stage
      // bodies were deliberately released above.
      const value: InvokeValue = { ...chosen, upstreamRequest: lastUpstreamRequest, response };
      prog?.record("agent", PROGRESS_NODE.AGENT_COMPLETE, `micro agent completed: ${calls.length} call(s), ${usage.totalTokens} tokens`, { calls: calls.length, totalTokens: usage.totalTokens });
      return { result: { ok: true, value }, attemptPath: calls, attempts: countAttempts(calls) };
    } catch (e) {
      const message = errorMessage(e);
      prog?.record("error", PROGRESS_NODE.AGENT_EXCEPTION, `agent execution error: ${message}`);
      return errorInv(`agent execution error: ${message}`);
    }
  }
}
