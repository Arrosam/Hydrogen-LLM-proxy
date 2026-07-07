import { ModelService, type InvokeOptions, type ServiceDeps } from "./modelService";
import { mergeOverrides, type RequestOverrides } from "../core/ir/params";
import type { Request } from "../core/ir/request";
import type { Response } from "../core/ir/response";
import { buildResponse } from "../core/format/registry";
import { textOf } from "../core/ir/content";
import { addUsage, ZERO_USAGE, type Usage } from "../core/ir/usage";
import { serializeForLog } from "../util/logPayload";
import { stageOverrides, type AgentDef } from "./definition";
import {
  buildOcrRequest,
  buildStageRequest,
  collectImages,
  inputContext,
  nextStep,
  parseOcrResults,
  translateImagesInRequest,
} from "./agentContext";
import type { AttemptFailure, AttemptRecord, AttemptResult } from "./steps";
import type { Invocation, InvokeValue, StreamInvocation } from "./outcome";

/** How deep nested Micro Agents may reference one another before we stop. */
const MAX_AGENT_DEPTH = 8;

/** Resolves a saved service name to a runnable executor (Model Service or nested agent). */
export type ResolveResult =
  | { ok: true; executor: ModelService; isAgent: boolean }
  | { ok: false; message: string };

export interface ServiceResolver {
  resolve(name: string): ResolveResult;
}

export interface MicroAgentDeps extends ServiceDeps {
  resolver: ServiceResolver;
  logMaxChars: number;
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
 * another Micro Agent. All of its internal calls are buffered (stream=false), so
 * routing conditions can see each stage's full output. For a streaming client it
 * buffers the whole run and replays the result as a paced stream.
 */
export class MicroAgent extends ModelService {
  private readonly resolver: ServiceResolver;
  private readonly logMaxChars: number;

  constructor(
    private readonly agent: AgentDef,
    deps: MicroAgentDeps,
  ) {
    // The base holds a placeholder step chain; a Micro Agent overrides invoke()/
    // stream() and never runs the base step loop.
    super({ timeoutMs: agent.timeoutMs, steps: [] }, deps);
    this.resolver = deps.resolver;
    this.logMaxChars = deps.logMaxChars;
  }

  /** A Micro Agent always buffers, then replays the complete result as a stream. */
  async stream(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<StreamInvocation> {
    return this.fabricated(await this.invoke(request, overrides, opts));
  }

  async invoke(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<Invocation> {
    const agent = this.agent;
    const stack = opts.stack ?? [];
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
          const ocrReq = buildOcrRequest(request, images, ocr);
          const { call, result } = await this.callService(ocrService, ocrReq, undefined, { stage: "(ocr)", service: ocr.service }, opts.signal, ocr.timeoutMs);
          calls.push(call);
          if (!result.ok) return fail(result);
          usage = addUsage(usage, result.value.response.usage);
          source = translateImagesInRequest(request, parseOcrResults(result.value.response.text(), images.length));
        }
      }

      // --- stage loop -------------------------------------------------------
      const input = inputContext(source);
      let idx = 0;
      while (idx >= 0 && idx < agent.stages.length) {
        const stage = agent.stages[idx];
        terminal = stage.name;

        if (isRouter(stage)) {
          outputs.set(stage.name, "");
          calls.push({ stage: stage.name, service: "(router)", kind: "router", status: 200, latencyMs: 0, attempts: [] });
        } else {
          // Outer overrides fold over this stage's config, the outer winning.
          const combined = mergeOverrides(stageOverrides(stage), overrides);
          const stageReq = buildStageRequest(source, stage, outputs, responses, false, combined?.system);
          const childOverrides = withoutSystem(combined);

          if (stage.service) {
            const r = this.resolver.resolve(stage.service);
            if (!r.ok) return errorInv(r.message);

            if (r.isAgent) {
              if (stack.includes(stage.service)) return errorInv(`micro-agent cycle detected: "${stage.service}" is already running`);
              if (stack.length >= MAX_AGENT_DEPTH) return errorInv(`micro-agent nesting too deep (>${MAX_AGENT_DEPTH})`);
              const started = Date.now();
              const wrapper: ServiceCall = { stage: stage.name, service: stage.service, kind: "agent", status: 0, latencyMs: 0, attempts: [], request: this.stageRequestPayload(stageReq), calls: [] };
              const sub = await r.executor.invoke(stageReq, childOverrides, { stack: [...stack, stage.service], signal: opts.signal, timeoutMs: stage.timeoutMs });
              wrapper.calls = sub.attemptPath as ServiceCall[];
              wrapper.latencyMs = Date.now() - started;
              calls.push(wrapper);
              if (!sub.result.ok) {
                wrapper.status = sub.result.status;
                wrapper.error = sub.result.message;
                return fail(sub.result);
              }
              wrapper.status = 200;
              wrapper.usage = sub.result.value.response.usage;
              wrapper.response = this.stageResponsePayload(sub.result.value.response);
              commit(stage.name, sub.result.value);
            } else {
              const { call, result } = await this.callService(r.executor, stageReq, childOverrides, { stage: stage.name, service: stage.service }, opts.signal, stage.timeoutMs);
              calls.push(call);
              if (!result.ok) return fail(result);
              commit(stage.name, result.value);
            }
          } else if (stage.steps && stage.steps.length) {
            const anon = new ModelService({ timeoutMs: stage.timeoutMs ?? agent.timeoutMs, steps: stage.steps }, this.deps);
            const { call, result } = await this.callService(anon, stageReq, childOverrides, { stage: stage.name }, opts.signal, stage.timeoutMs);
            calls.push(call);
            if (!result.ok) return fail(result);
            commit(stage.name, result.value);
          } else {
            return errorInv(`stage "${stage.name}" has no Model Service or steps`);
          }
        }

        const step = nextStep(stage, idx, byName, input, outputs);
        if ("end" in step) {
          if (step.output) returnStage = step.output;
          break;
        }
        idx = step.index;
      }

      const chosen = (returnStage ? values.get(returnStage) : undefined) ?? values.get(terminal) ?? lastValue;
      if (!chosen) return errorInv("agent produced no model output");
      // Report the agent's total usage across all stages on the returned response.
      const response = buildResponse(chosen.family, { ...chosen.response.data(), usage });
      const value: InvokeValue = { ...chosen, response };
      return { result: { ok: true, value }, attemptPath: calls, attempts: countAttempts(calls) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
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
  ): Promise<{ call: ServiceCall; result: AttemptResult<InvokeValue> }> {
    const started = Date.now();
    const inv = await service.invoke(stageReq, overrides, { signal, timeoutMs });
    const path = inv.attemptPath as AttemptRecord[];
    const call: ServiceCall = {
      stage: meta.stage,
      service: meta.service ?? "(inline)",
      kind: "service",
      status: inv.result.ok ? 200 : inv.result.status,
      latencyMs: Date.now() - started,
      attempts: path,
      request: inv.result.ok ? serializeForLog(inv.result.value.upstreamRequest, this.logMaxChars) : this.stageRequestPayload(stageReq),
    };
    if (inv.result.ok) {
      call.usage = inv.result.value.response.usage;
      call.response = this.stageResponsePayload(inv.result.value.response);
    } else {
      call.error = inv.result.message;
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
      this.logMaxChars,
    );
  }

  private stageResponsePayload(response: Response): string {
    return serializeForLog(response.toLogPayload(), this.logMaxChars);
  }
}
