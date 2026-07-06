import type { Readable } from "node:stream";
import type { Family, IRRequest, IRResponse } from "../ir";
import { adapterFor } from "../formats";
import { collectStream, parseUpstreamStream } from "../formats/stream";
import { buildHeaders, chatUrl, postJson, postStream } from "../upstream";
import { resolveMapping } from "../../services/catalog";
import { runSteps, type AttemptResult, type RunOutput } from "../services/engine";
import type { ServiceStep, ServiceSteps } from "../services/schema";

export interface AttemptTargetInfo {
  family: Family;
  upstreamModel: string;
  providerName: string;
  modelName: string;
  /** The body actually sent upstream (after translation + step overrides). */
  upstreamRequest: Record<string, unknown>;
}

export interface JsonSuccess extends AttemptTargetInfo {
  ir: IRResponse;
}

export interface StreamSuccess extends AttemptTargetInfo {
  body: Readable;
  /** True when the effective thinking level is "disabled": the relay drops any
   * reasoning the upstream emits anyway, so a disabled override is honored even
   * when the provider ignores the request to stop thinking. */
  dropReasoning?: boolean;
}

function resolveStepMapping(step: ServiceStep):
  | { ok: true; mapping: NonNullable<ReturnType<typeof resolveMapping>["mapping"]> }
  | { ok: false; message: string } {
  const res = resolveMapping(step.model, step.provider);
  if (!res.ok || !res.mapping) {
    return { ok: false, message: `mapping ${step.model}@${step.provider}: ${res.error}` };
  }
  return { ok: true, mapping: res.mapping };
}

/** Apply a step's per-step overrides (currently the thinking level) to the IR.
 * A step-level thinking override wins over whatever the client requested. */
export function applyStepOverrides(ir: IRRequest, step: ServiceStep): IRRequest {
  return step.thinking ? { ...ir, thinking: step.thinking } : ir;
}

/** Drop reasoning parts from a response IR. Used to honor a "disabled" thinking
 * level end-to-end: even if the upstream ignores the request to stop thinking
 * and returns reasoning anyway, the client must not see a thinking block. */
function stripReasoning(ir: IRResponse): IRResponse {
  const content = ir.content.filter((p) => p.type !== "reasoning");
  return content.length === ir.content.length ? ir : { ...ir, content };
}

/** Run a service's steps for a non-streaming request. */
export function runServiceJson(ir: IRRequest, steps: ServiceSteps): Promise<RunOutput<JsonSuccess>> {
  const attempt = async (step: ServiceStep): Promise<AttemptResult<JsonSuccess>> => {
    const resolved = resolveStepMapping(step);
    if (!resolved.ok) return { ok: false, status: 0, kind: "error", message: resolved.message };
    const m = resolved.mapping;
    const merged = applyStepOverrides(ir, step);
    const upstreamBody = adapterFor(m.family).irToRequest({ ...merged, stream: false }, m.upstreamModel);
    const r = await postJson(chatUrl(m.upstream), buildHeaders(m.upstream), upstreamBody, {
      timeoutMs: steps.timeoutMs,
    });
    if (r.status >= 200 && r.status < 300 && r.json && typeof r.json === "object") {
      let respIR = adapterFor(m.family).responseToIR(r.json as Record<string, unknown>);
      if (merged.thinking === "disabled") respIR = stripReasoning(respIR);
      return {
        ok: true,
        value: {
          ir: respIR,
          family: m.family,
          upstreamModel: m.upstreamModel,
          providerName: m.providerName,
          modelName: m.modelName,
          upstreamRequest: upstreamBody,
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

/**
 * Run a service's steps as an upstream STREAM consumed inside the proxy,
 * returning the buffered result. Used for Micro Agent stage/OCR calls: routing
 * needs the complete output, but streaming upstream still captures reasoning
 * from providers that only emit it on streams and avoids idle non-streaming
 * timeouts during long thinking. Mid-stream failures count as attempt
 * failures, so the step's retry/advance rules apply.
 */
export function runServiceBuffered(ir: IRRequest, steps: ServiceSteps): Promise<RunOutput<JsonSuccess>> {
  const attempt = async (step: ServiceStep): Promise<AttemptResult<JsonSuccess>> => {
    const resolved = resolveStepMapping(step);
    if (!resolved.ok) return { ok: false, status: 0, kind: "error", message: resolved.message };
    const m = resolved.mapping;
    const merged = applyStepOverrides(ir, step);
    const upstreamBody = adapterFor(m.family).irToRequest({ ...merged, stream: true }, m.upstreamModel);
    const r = await postStream(chatUrl(m.upstream), buildHeaders(m.upstream), upstreamBody, {
      timeoutMs: steps.timeoutMs,
    });
    if (r.status >= 200 && r.status < 300) {
      // A consumption error throws and is mapped to a retryable failure by runSteps.
      const collected = await collectStream(parseUpstreamStream(m.family, r.body));
      // A truncated stream (no terminal event) is retried like any other
      // failure instead of being accepted as a partial, usage-less "success".
      // Reported as an http 502 so a step's numeric 502 retry/advance trigger
      // matches it (the upstream delivered an incomplete response).
      if (collected.incomplete) {
        return {
          ok: false,
          status: 502,
          kind: "http",
          message: "upstream stream ended before completion (truncated)",
        };
      }
      const respIR = merged.thinking === "disabled" ? stripReasoning(collected.ir) : collected.ir;
      return {
        ok: true,
        value: {
          ir: respIR,
          family: m.family,
          upstreamModel: m.upstreamModel,
          providerName: m.providerName,
          modelName: m.modelName,
          upstreamRequest: upstreamBody,
        },
      };
    }
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

/** Run a service's steps for a streaming request (commits once headers are 2xx). */
export function runServiceStream(ir: IRRequest, steps: ServiceSteps): Promise<RunOutput<StreamSuccess>> {
  const attempt = async (step: ServiceStep): Promise<AttemptResult<StreamSuccess>> => {
    const resolved = resolveStepMapping(step);
    if (!resolved.ok) return { ok: false, status: 0, kind: "error", message: resolved.message };
    const m = resolved.mapping;
    const merged = applyStepOverrides(ir, step);
    const upstreamBody = adapterFor(m.family).irToRequest({ ...merged, stream: true }, m.upstreamModel);
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
          upstreamRequest: upstreamBody,
          dropReasoning: merged.thinking === "disabled",
        },
      };
    }
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