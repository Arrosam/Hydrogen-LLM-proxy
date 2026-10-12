import type { Request } from "../core/ir/request";
import type { Response } from "../core/ir/response";
import type { RequestOverrides } from "../core/ir/params";
import type { Usage } from "../core/ir/usage";
import { failureMessage } from "../core/proxy/errors";
import { serializeForLog } from "../util/logPayload";
import type { InvokeOptions, ModelService } from "./modelService";
import type { Invocation, InvokeValue, StreamInvocation } from "./outcome";
import type { AttemptRecord, AttemptResult } from "./steps";
import { HTTP_STATUS } from "../util/httpStatus";

/** Stand-in service names recorded for a call that is not a saved service. */
export const CALL_LABEL = { INLINE: "(inline)", OCR: "(ocr)", ASR: "(asr)", ROUTER: "(router)" } as const;

/** A model invocation inside an orchestrated run, including nested agents. */
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

export function countAttempts(calls: ServiceCall[]): number {
  return calls.reduce((n, call) => n + call.attempts.length + (call.calls ? countAttempts(call.calls) : 0), 0);
}

export function requestPayload(request: Request, maxChars: number): string {
  return serializeForLog({
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    tool_choice: request.toolChoice,
    params: request.params,
  }, maxChars);
}

export function responsePayload(response: Response, maxChars: number): string {
  return serializeForLog(response.toLogPayload(), maxChars);
}

/**
 * The part of a ServiceCall that an invocation's outcome alone decides. A path
 * made of ServiceCalls means the callee was itself an orchestrator (a nested
 * agent), which is recorded as `calls`; otherwise the path is the callee's own
 * attempts. A failure's status is recorded as reported; a caller that answers
 * its client with it maps it separately.
 */
export function invocationCall(
  inv: Pick<Invocation | StreamInvocation, "result" | "attemptPath">,
  meta: { stage: string; service: string },
  started: number,
): ServiceCall {
  const path = Array.isArray(inv.attemptPath) ? inv.attemptPath : [];
  const nested = path.some(entry => entry && typeof entry === "object" && "stage" in entry);
  return {
    stage: meta.stage,
    service: meta.service,
    kind: nested ? "agent" : "service",
    status: inv.result.ok ? HTTP_STATUS.OK : inv.result.status,
    latencyMs: Date.now() - started,
    attempts: nested ? [] : path as AttemptRecord[],
    ...(nested ? { calls: path as ServiceCall[] } : {}),
  };
}

/** Shared by Micro Agent stages and hosted-tool model rounds. */
export async function callService(
  service: Pick<ModelService, "invoke">,
  request: Request,
  overrides: RequestOverrides | undefined,
  meta: { stage: string; service?: string },
  opts: InvokeOptions,
  logMaxChars: () => number,
): Promise<{ call: ServiceCall; result: AttemptResult<InvokeValue>; attempts: number }> {
  const started = Date.now();
  const inv = await service.invoke(request, overrides, opts);
  const call = invocationCall(inv, { stage: meta.stage, service: meta.service ?? CALL_LABEL.INLINE }, started);
  call.request = inv.result.ok
    ? serializeForLog(inv.result.value.upstreamRequest, logMaxChars())
    : requestPayload(request, logMaxChars());
  if (inv.result.ok) {
    call.usage = inv.result.value.response.usage;
    call.response = responsePayload(inv.result.value.response, logMaxChars());
  } else {
    call.usage = inv.usage;
    call.error = failureMessage(inv.result);
  }
  return { call, result: inv.result, attempts: inv.attempts };
}
