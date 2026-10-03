import { ModelService, type InvokeOptions, type ServiceDeps } from "./modelService";
import type { Request } from "../core/ir/request";
import type { RequestOverrides } from "../core/ir/params";
import type { HttpTool } from "./toolHttp";
import type { HostedToolOptions } from "./definition";
import { HostedRunError, runHostedTools } from "./hostedToolLoop";
import type { Invocation, StreamInvocation } from "./outcome";
import { genId } from "../util/ids";
import { countAttempts } from "./serviceCall";
import { combineServerToolAvailability, prepareServerTools, ServerToolPreflightError, type PreparedServerTools } from "./serverTools";

/** A named Micro Agent stage executes its own operator-bound tools before returning. */
export class HostedToolService extends ModelService {
  constructor(private readonly inner: ModelService, deps: ServiceDeps, private readonly tools: HttpTool[], private readonly config?: HostedToolOptions) {
    super({ timeoutMs: inner.timeoutMs, steps: [] }, deps);
  }
  override get thinkingProcessing(): boolean {
    return this.inner.thinkingProcessing !== false;
  }
  override prepareTools(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): PreparedServerTools {
    const serverTools = combineServerToolAvailability(this.tools, opts.serverTools, this.serverToolNamePrefix);
    return this.inner.prepareTools
      ? this.inner.prepareTools(request, overrides, { ...opts, serverTools })
      : prepareServerTools(request.withOverrides(overrides), serverTools);
  }
  override async invoke(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<Invocation> {
    try {
      const serverTools = combineServerToolAvailability(this.tools, opts.serverTools, this.serverToolNamePrefix);
      const run = await runHostedTools(this.inner, request, serverTools.tools, this.deps.transport,
        { ...opts, serverTools, serverToolNamePrefix: serverTools.prefix, modelOverrides: overrides, sessionId: opts.hosted?.sessionId ?? genId("session"), config: this.config, emit: opts.hosted?.emit });
      return { result: { ok: true, value: { ...run.value, hostedToolReceipts: run.receipts } }, attempts: run.attempts, attemptPath: run.calls };
    } catch (error) {
      if (error instanceof ServerToolPreflightError) return { result: error.failure(), attempts: 0, attemptPath: [] };
      if (!(error instanceof HostedRunError)) throw error;
      return { result: { ok: false, kind: "error", status: error.statusCode, message: error.message, errorBody: error.errorBody, usage: error.usage }, usage: error.usage, attemptPath: error.calls, attempts: countAttempts(error.calls) };
    }
  }
  override async stream(request: Request, overrides?: RequestOverrides, opts: InvokeOptions = {}): Promise<StreamInvocation> {
    const startedAt = Date.now();
    return this.fabricated(await this.invoke(request, overrides, opts), startedAt);
  }
}
