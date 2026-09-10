import { ModelService, type InvokeOptions, type ServiceDeps } from "./modelService.js";
import type { Request } from "@areelai/wire-format";
import type { RequestOverrides } from "@areelai/wire-format";
import type { HttpTool } from "./toolHttp.js";
import type { HostedToolOptions } from "./definition.js";
import { HostedRunError, runHostedTools } from "./hostedToolLoop.js";
import type { Invocation, StreamInvocation } from "./outcome.js";
import { genId } from "@areelai/common";

/** A named Micro Agent stage executes its own operator-bound tools before returning. */
export class HostedToolService extends ModelService {
  constructor(private readonly inner: ModelService, deps: ServiceDeps, private readonly tools: HttpTool[], private readonly config?: HostedToolOptions) {
    super({ timeoutMs: inner.timeoutMs, steps: [] }, deps);
  }
  override async invoke(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<Invocation> {
    try {
      const run = await runHostedTools(this.inner, request.withOverrides(overrides), this.tools, this.deps.transport,
        { ...opts, sessionId: opts.hosted?.sessionId ?? genId("session"), config: this.config, emit: opts.hosted?.emit });
      return { result: { ok: true, value: run.value }, attempts: run.attempts, attemptPath: run.calls };
    } catch (error) {
      if (!(error instanceof HostedRunError)) throw error;
      return { result: { ok: false, kind: "error", status: error.statusCode, message: error.message }, usage: error.usage, attemptPath: error.calls, attempts: error.calls.reduce((n, call) => n + call.attempts.length, 0) };
    }
  }
  override async stream(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<StreamInvocation> {
    return this.fabricated(await this.invoke(request, overrides, opts), Date.now());
  }
}
