import type { Request } from "@areelai/wire-format";
import type { Response } from "@areelai/wire-format";
import type { RequestOverrides } from "@areelai/wire-format";
import type { Usage } from "@areelai/wire-format";
import { failureMessage } from "@areelai/wire-format";
import { serializeForLog } from "@areelai/common";
import type { InvokeOptions, ModelService } from "./modelService.js";
import type { InvokeValue } from "./outcome.js";
import type { AttemptRecord, AttemptResult } from "./steps.js";

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
  const path = Array.isArray(inv.attemptPath) ? inv.attemptPath : [];
  const nested = path.some(entry => entry && typeof entry === "object" && "stage" in entry);
  const call: ServiceCall = {
    stage: meta.stage,
    service: meta.service ?? "(inline)",
    kind: nested ? "agent" : "service",
    status: inv.result.ok ? 200 : inv.result.status,
    latencyMs: Date.now() - started,
    attempts: nested ? [] : path as AttemptRecord[],
    ...(nested ? { calls: path as ServiceCall[] } : {}),
    request: inv.result.ok
      ? serializeForLog(inv.result.value.upstreamRequest, logMaxChars())
      : requestPayload(request, logMaxChars()),
  };
  if (inv.result.ok) {
    call.usage = inv.result.value.response.usage;
    call.response = responsePayload(inv.result.value.response, logMaxChars());
  } else {
    call.usage = inv.usage;
    call.error = failureMessage(inv.result);
  }
  return { call, result: inv.result, attempts: inv.attempts };
}
