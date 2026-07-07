import { buildRequest } from "../core/format/registry";
import type { RequestOverrides } from "../core/ir/params";
import type { Request } from "../core/ir/request";
import type { SendTarget, Transport } from "../core/upstream/transport";
import type { Catalog } from "../catalog/catalog";
import { runSteps } from "./steps";
import type { ServiceSteps } from "./definition";
import type { Invocation, InvokeValue, StreamInvocation, StreamValue } from "./outcome";

/** Shared dependencies every executor needs. */
export interface ServiceDeps {
  catalog: Catalog;
  transport: Transport;
}

export interface InvokeOptions {
  /** Aborts the upstream call (client disconnect). */
  signal?: AbortSignal;
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
  private merge(request: Request, step: { overrides?: unknown }, overrides?: RequestOverrides): Request {
    return request.withOverrides(step.overrides as RequestOverrides | undefined).withOverrides(overrides);
  }

  async invoke(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<Invocation> {
    const { result, path } = await runSteps<InvokeValue>(this.def, async (step) => {
      const res = this.deps.catalog.resolve(step.model, step.provider);
      if (!res.ok) {
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
        timeoutMs: this.def.timeoutMs,
        signal: opts.signal,
      };
      const sent = await egress.send(this.deps.transport, target);
      if (!sent.ok) {
        return { ok: false, status: sent.status, kind: sent.kind, message: sent.message, errorBody: sent.body };
      }
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
    });
    return { result, attemptPath: path, attempts: path.length };
  }

  async stream(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<StreamInvocation> {
    const { result, path } = await runSteps<StreamValue>(this.def, async (step) => {
      const res = this.deps.catalog.resolve(step.model, step.provider);
      if (!res.ok) {
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
        timeoutMs: this.def.timeoutMs,
        signal: opts.signal,
      };
      const sent = await egress.relay(this.deps.transport, target);
      if (!sent.ok) {
        return { ok: false, status: sent.status, kind: sent.kind, message: sent.message, errorBody: sent.body };
      }
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
    });
    return { result, attemptPath: path, attempts: path.length };
  }
}
