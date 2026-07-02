import type { Readable } from "node:stream";
import type { Family, IRRequest, IRResponse } from "../ir";
import { adapterFor } from "../formats";
import { buildHeaders, chatUrl, postJson, postStream } from "../upstream";
import { resolveMapping } from "../../services/catalog";
import { runSteps, type AttemptResult, type RunOutput } from "../mub/engine";
import type { MubStep, MubSteps } from "../mub/schema";

export interface AttemptTargetInfo {
  family: Family;
  upstreamModel: string;
  providerName: string;
  modelName: string;
}

export interface JsonSuccess extends AttemptTargetInfo {
  ir: IRResponse;
}

export interface StreamSuccess extends AttemptTargetInfo {
  body: Readable;
}

function resolveStepMapping(step: MubStep):
  | { ok: true; mapping: NonNullable<ReturnType<typeof resolveMapping>["mapping"]> }
  | { ok: false; message: string } {
  const res = resolveMapping(step.model, step.provider);
  if (!res.ok || !res.mapping) {
    return { ok: false, message: `mapping ${step.model}@${step.provider}: ${res.error}` };
  }
  return { ok: true, mapping: res.mapping };
}

/** Run a MUB's steps for a non-streaming request. */
export function runMubJson(ir: IRRequest, steps: MubSteps): Promise<RunOutput<JsonSuccess>> {
  const attempt = async (step: MubStep): Promise<AttemptResult<JsonSuccess>> => {
    const resolved = resolveStepMapping(step);
    if (!resolved.ok) return { ok: false, status: 0, kind: "error", message: resolved.message };
    const m = resolved.mapping;
    const upstreamBody = adapterFor(m.family).irToRequest({ ...ir, stream: false }, m.upstreamModel);
    const r = await postJson(chatUrl(m.upstream), buildHeaders(m.upstream), upstreamBody, {
      timeoutMs: steps.timeoutMs,
    });
    if (r.status >= 200 && r.status < 300 && r.json && typeof r.json === "object") {
      const respIR = adapterFor(m.family).responseToIR(r.json as Record<string, unknown>);
      return {
        ok: true,
        value: {
          ir: respIR,
          family: m.family,
          upstreamModel: m.upstreamModel,
          providerName: m.providerName,
          modelName: m.modelName,
        },
      };
    }
    return {
      ok: false,
      status: r.status,
      kind: r.status > 0 ? "http" : "error",
      message: `upstream returned ${r.status}`,
      errorBody: r.json ?? r.text,
    };
  };

  return runSteps(steps, attempt);
}

/** Run a MUB's steps for a streaming request (commits once headers are 2xx). */
export function runMubStream(ir: IRRequest, steps: MubSteps): Promise<RunOutput<StreamSuccess>> {
  const attempt = async (step: MubStep): Promise<AttemptResult<StreamSuccess>> => {
    const resolved = resolveStepMapping(step);
    if (!resolved.ok) return { ok: false, status: 0, kind: "error", message: resolved.message };
    const m = resolved.mapping;
    const upstreamBody = adapterFor(m.family).irToRequest({ ...ir, stream: true }, m.upstreamModel);
    const r = await postStream(chatUrl(m.upstream), buildHeaders(m.upstream), upstreamBody, {
      timeoutMs: steps.timeoutMs,
    });
    if (r.status >= 200 && r.status < 300) {
      return {
        ok: true,
        value: {
          body: r.body,
          family: m.family,
          upstreamModel: m.upstreamModel,
          providerName: m.providerName,
          modelName: m.modelName,
        },
      };
    }
    // Drain the error body so we can relay a useful message.
    let errText = "";
    try {
      for await (const chunk of r.body) errText += chunk.toString();
    } catch {
      /* ignore */
    }
    let errBody: unknown = errText;
    try {
      errBody = errText ? JSON.parse(errText) : errText;
    } catch {
      /* keep text */
    }
    return {
      ok: false,
      status: r.status,
      kind: "http",
      message: `upstream returned ${r.status}`,
      errorBody: errBody,
    };
  };

  return runSteps(steps, attempt);
}
