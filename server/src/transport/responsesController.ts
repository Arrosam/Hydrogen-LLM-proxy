import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Family } from "../core/format/family";
import { buildRequest, buildResponse, parseRequest } from "../core/format/registry";
import type { Message } from "../core/ir/content";
import { ZERO_USAGE } from "../core/ir/usage";
import { requireClientToken } from "../auth/tokenAuth";
import { buildErrorBody } from "../core/proxy/errors";
import { parseService, isChatPipeline, serviceCategory, serviceThinkingDelimiters, serviceThinkingFormat } from "../execution/definition";
import { runHostedTools, HostedRunError } from "../execution/hostedToolLoop";
import { collectServerToolCalls, declaredServerTools, hostedServerTools, rewriteServerTools, serverToolParts, serverToolResponseContent } from "../execution/serverTools";
import { ResponseStateError, type ResponseRepo, type StoredResponse, type WireItem } from "../persistence/responseRepo";
import type { HostedToolRepo } from "../persistence/hostedToolRepo";
import { ProgressRecorder } from "../observability/progressRecorder";
import { genId } from "../util/ids";
import type { ProxyDeps } from "./deps";
import { JsonKeepalive } from "./jsonKeepalive";
import { messagesToItems, responseWire } from "./responseWire";
import { liveResponseWire } from "./liveResponseWire";
import type { InvokeValue } from "../execution/outcome";

const metadata = z.record(z.string().max(64), z.string().max(512)).refine(v => Object.keys(v).length <= 16, "At most 16 metadata entries");
const items = z.array(z.record(z.unknown())).max(100);
const page = z.object({ after: z.string().optional(), order: z.enum(["asc", "desc"]).default("desc"), limit: z.coerce.number().int().min(1).max(100).default(20) });
const idFrom = (req: FastifyRequest, key = "id") => z.record(z.string()).parse(req.params)[key]!;
const active = (row: Pick<StoredResponse, "status">) => row.status === "queued" || row.status === "in_progress";
const list = (data: WireItem[], has_more = false) => ({ object: "list", data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more });
type Job = { abort: AbortController; done: Promise<WireItem>; bytes: number; status?: number; error?: string | null };

/** Durable, API-Key-owned orchestration; the regular proxy remains the stateless path. */
export class ResponsesController {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly deps: ProxyDeps, private readonly repo: ResponseRepo, private readonly tools: HostedToolRepo) {}

  accepts(body: unknown, family: Family): boolean {
    if (family === "openai_responses") return true;
    if (family !== "anthropic" || !body || typeof body !== "object") return false;
    const value = body as WireItem;
    if (value.hydrogen) return true;
    const service = typeof value.model === "string" ? this.deps.services.getByName(value.model) : undefined;
    return !!service && (this.deps.factory.hasHostedTools?.(service) ?? this.tools.forService(service.id).length > 0);
  }

  register(app: FastifyInstance): void {
    void app.register(async scoped => {
      scoped.setErrorHandler((error, req, reply) => {
        const status = error instanceof ResponseStateError ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
        if (status === 500) req.log.error({ err: error }, "response state operation failed");
        return reply.code(status).send(buildErrorBody("openai_responses", status, status < 500 && error instanceof Error ? error.message : "Response state operation failed"));
      });
      this.registerStateRoutes(scoped);
    });
  }

  private registerStateRoutes(app: FastifyInstance): void {
    const auth = requireClientToken(this.deps.tokens, "openai_responses", false);
    const owned = (req: FastifyRequest) => {
      const row = this.repo.response(idFrom(req), req.clientToken!.id);
      if (!row || row.response.store === false) throw new ResponseStateError("Response not found");
      return row;
    };
    app.get("/v1/responses/:id", { preHandler: auth }, async (req, reply) => {
      const row = owned(req);
      const query = z.object({ stream: z.enum(["true", "false"]).optional(), starting_after: z.coerce.number().int().min(-1).optional() }).parse(req.query);
      if (query.stream === "true") return this.follow(reply, row, query.starting_after ?? -1);
      return row.response;
    });
    app.delete("/v1/responses/:id", { preHandler: auth }, req => {
      const row = owned(req); this.repo.deleteResponse(row.id, row.tokenId);
      return { id: row.id, object: "response", deleted: true };
    });
    app.post("/v1/responses/:id/cancel", { preHandler: auth }, req => {
      const row = owned(req);
      if (!row.background) throw new ResponseStateError("Only background responses can be cancelled", 400);
      if (!active(row)) return row.response;
      const cancelled = this.repo.transition(row.id, row.tokenId, "cancelled", { ...row.response, error: null });
      this.jobs.get(row.id)?.abort.abort();
      this.repo.addEvent(row.id, row.tokenId, { type: "response.cancelled", response: cancelled!.response });
      return cancelled!.response;
    });
    app.get("/v1/responses/:id/input_items", { preHandler: auth }, req => {
      const row = owned(req), query = page.parse(req.query);
      let data = [...row.inputItems];
      if (query.order === "desc") data.reverse();
      if (query.after) {
        const index = data.findIndex(item => item.id === query.after);
        if (index < 0) throw new ResponseStateError("Item cursor not found", 400);
        data = data.slice(index + 1);
      }
      return list(data.slice(0, query.limit), data.length > query.limit);
    });
    const conversationBody = z.object({ metadata: metadata.default({}), items: items.default([]) });
    const present = (row: ReturnType<ResponseRepo["createConversation"]>) => ({ id: row.id, object: "conversation", created_at: Math.floor(row.createdAt.getTime() / 1000), metadata: row.metadata });
    const conversation = (req: FastifyRequest) => {
      const row = this.repo.conversation(idFrom(req), req.clientToken!.id);
      if (!row) throw new ResponseStateError("Conversation not found");
      return row;
    };
    app.post("/v1/conversations", { preHandler: auth }, req => {
      const body = conversationBody.parse(req.body ?? {});
      this.validateItems(body.items);
      return present(this.repo.createConversation(req.clientToken!.id, body.metadata, body.items));
    });
    app.get("/v1/conversations/:id", { preHandler: auth }, req => present(conversation(req)));
    app.post("/v1/conversations/:id", { preHandler: auth }, req => {
      const body = z.object({ metadata }).parse(req.body);
      return present(this.repo.updateConversation(idFrom(req), req.clientToken!.id, body.metadata));
    });
    app.delete("/v1/conversations/:id", { preHandler: auth }, req => {
      this.repo.deleteConversation(idFrom(req), req.clientToken!.id);
      return { id: idFrom(req), object: "conversation.deleted", deleted: true };
    });
    app.get("/v1/conversations/:id/items", { preHandler: auth }, req => {
      const result = this.repo.items(idFrom(req), req.clientToken!.id, page.parse(req.query));
      return list(result.data, result.has_more);
    });
    app.post("/v1/conversations/:id/items", { preHandler: auth }, req => {
      const body = z.object({ items }).parse(req.body);
      this.validateItems(body.items);
      return list(this.repo.appendItems(idFrom(req), req.clientToken!.id, body.items));
    });
    app.get("/v1/conversations/:id/items/:itemId", { preHandler: auth }, req => {
      const item = this.repo.item(idFrom(req), req.clientToken!.id, idFrom(req, "itemId"));
      if (!item) throw new ResponseStateError("Conversation item not found");
      return item;
    });
    app.delete("/v1/conversations/:id/items/:itemId", { preHandler: auth }, req => {
      this.repo.deleteItem(idFrom(req), req.clientToken!.id, idFrom(req, "itemId"));
      return present(conversation(req));
    });
    const prune = setInterval(() => {
      // A prune fault (a full disk, say) must not become an uncaught exception
      // in a timer and take the process down; the next tick retries.
      try { this.repo.prune(); } catch (error) { app.log.warn({ err: error }, "response prune failed"); }
    }, 60_000);
    prune.unref();
    app.addHook("onClose", async () => {
      clearInterval(prune);
      for (const job of this.jobs.values()) job.abort.abort();
      await Promise.allSettled([...this.jobs.values()].map(job => job.done));
    });
  }

  private validateItems(input: WireItem[]): void {
    for (const item of input) {
      if (!["message", "function_call", "function_call_output", "reasoning"].includes(String(item.type ?? "message"))) throw new ResponseStateError("Unsupported conversation input item type", 400);
    }
  }

  async create(req: FastifyRequest, reply: FastifyReply, family: Family): Promise<unknown> {
    try { return await this.createOwned(req, reply, family); }
    catch (error) {
      const status = error instanceof ResponseStateError || error instanceof HostedRunError ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
      return reply.code(status).send(buildErrorBody(family, status, status < 500 ? (error as Error).message : "Response execution failed"));
    }
  }

  private async createOwned(req: FastifyRequest, reply: FastifyReply, family: Family): Promise<unknown> {
    const body = z.record(z.unknown()).parse(req.body), token = req.clientToken!;
    const flags = z.object({ stream: z.boolean().default(false), store: z.boolean().default(true), background: z.boolean().default(false), previous_response_id: z.string().nullable().optional(), conversation: z.union([z.string(), z.object({ id: z.string() })]).nullable().optional(), metadata: metadata.default({}) }).parse(body);
    if (flags.background && (!flags.store || family !== "openai_responses")) throw new ResponseStateError("Background requires Responses with store:true", 400);
    if (this.jobs.size >= 32) throw new ResponseStateError("Too many active response jobs", 429);
    const extension = z.object({ previous_response_id: z.string().optional() }).parse(body.hydrogen ?? {});
    const previousId = flags.previous_response_id ?? extension.previous_response_id;
    const conversationId = typeof flags.conversation === "string" ? flags.conversation : flags.conversation?.id;
    if (previousId && conversationId) throw new ResponseStateError("previous_response_id and conversation cannot be combined", 400);
    const clean = { ...body }; for (const field of ["hydrogen", "previous_response_id", "conversation", "background"]) delete clean[field];
    if (family === "openai_responses" && body.input !== undefined && typeof body.input !== "string" && !Array.isArray(body.input)) throw new ResponseStateError("input must be a string or an item array", 400);
    if (body.prompt !== undefined) throw new ResponseStateError("Provider-stored prompt templates are not supported", 400);
    if (Array.isArray(body.input)) this.validateItems(z.array(z.record(z.unknown())).parse(body.input));
    let request = parseRequest(family, clean);
    const allow = family === "anthropic" ? ["anthropic-beta"] : ["openai-beta", "http-referer", "x-title"];
    const forwarded: Record<string, string> = {};
    for (const name of allow) if (typeof req.headers[name] === "string") forwarded[name] = req.headers[name] as string;
    if (Object.keys(forwarded).length) request = request.withOverrides({ forwardHeaders: { family, headers: forwarded } });
    if (!request.requestedService) throw new ResponseStateError("Missing model", 400);
    if ((request.params.n ?? 1) > 1) throw new ResponseStateError("n > 1 is unsupported", 400);
    const service = this.deps.services.getByName(request.requestedService);
    if (!service || !service.enabled) throw new ResponseStateError("Model service not found");
    if (token.scopeServices?.length && !token.scopeServices.includes(service.id)) throw new ResponseStateError("API key does not allow this service", 403);
    const definition = parseService(service.definition);
    if (!isChatPipeline(serviceCategory(definition))) throw new ResponseStateError("Use the service's dedicated endpoint", 400);
    let prefix: Message[] = [];
    let previousSession: string | undefined;
    const conversation = conversationId ? this.repo.conversation(conversationId, token.id) : undefined;
    if (conversationId && !conversation) throw new ResponseStateError("Conversation not found");
    if (conversation) prefix = parseRequest("openai_responses", { model: service.name, input: this.repo.allItems(conversation.id, token.id) }).messages;
    if (previousId) {
      const previous = this.repo.response(previousId, token.id);
      if (!previous || previous.response.store === false) throw new ResponseStateError("Previous response not found");
      if (active(previous) || previous.status === "failed" || previous.status === "cancelled") throw new ResponseStateError("Previous response is not ready for continuation", 409);
      prefix = previous.history;
      const previousHydrogen = previous.response.hydrogen as WireItem | undefined;
      if (typeof previousHydrogen?.session_id === "string") previousSession = previousHydrogen.session_id;
      this.repo.touchResponse(previousId, token.id);
    }
    // A continuation supplies only new input. Every outstanding client call must be resolved.
    if (prefix.length) {
      const pending = new Set<string>();
      for (const message of prefix) for (const part of message.content) {
        if (part.type === "tool_use") pending.add(part.id);
        if (part.type === "tool_result") pending.delete(part.toolUseId);
      }
      for (const message of request.messages) for (const part of message.content) if (part.type === "tool_result") {
        if (!pending.delete(part.toolUseId)) throw new ResponseStateError("Tool result does not match an outstanding client call", 400);
      }
      if (pending.size) throw new ResponseStateError("Supply results for all outstanding client tool calls before continuing", 400);
    }
    request = buildRequest(family, { ...request.data(), messages: [...prefix, ...request.messages] });
    if (Buffer.byteLength(JSON.stringify(request.messages)) > 25 * 1024 * 1024) throw new ResponseStateError("Response context exceeds 25 MiB", 413);
    const bound = this.tools.forService(service.id);
    // A client may DECLARE a provider-executed tool by name. When a bound tool
    // opts into that contract, the declaration is an instruction to run it, not
    // a client tool that would collide with the hosted one.
    const serverTools = hostedServerTools(request.tools, bound);
    // A tool a client declares by the name a bound tool's OWN contract names is an
    // instruction to run that tool, not a collision. Any other name a hosted tool
    // answers to still is one: the model would see two definitions of it.
    const declaredNames = new Set(bound.flatMap(tool => tool.serverTool ? [tool.serverTool.name] : []));
    if (request.tools?.some(tool => !declaredNames.has(tool.name) && bound.some(b => b.name === tool.name))) throw new ResponseStateError("Client and hosted tool names must be distinct", 400);
    const tools = rewriteServerTools(request.tools, serverTools);
    const executor = this.deps.factory.forRow(service).executor;
    const id = genId("resp"), created = Math.floor(Date.now() / 1000), started = Date.now();
    const sessionId = conversationId ?? previousSession ?? id;
    const initial: WireItem = { id, object: "response", created_at: created, status: "queued", model: service.name, output: [], error: null, incomplete_details: null,
      background: flags.background, store: flags.store, previous_response_id: previousId ?? null, conversation: conversationId ? { id: conversationId } : null, metadata: flags.metadata };
    const row = this.repo.createResponse({ id, tokenId: token.id, serviceId: service.id, previousResponseId: previousId, conversationId, status: "queued", background: flags.background, response: initial,
      inputItems: messagesToItems(request.messages).map(item => ({ ...item, id: item.id ?? genId("item") })), history: request.messages }, conversation?.revision);
    const traceId = genId("req"), abort = new AbortController();
    const http = { method: req.method, path: req.url.split("?")[0]!, query: "", headers: req.headers as Record<string, unknown>, bodyPayload: this.deps.logger.capture(body) };
    req.body = undefined;
    this.deps.activeRequests.start({ traceId, tokenId: token.id, serviceId: service.id, serviceName: service.name, ingress: family, streaming: flags.stream });
    const progress = new ProgressRecorder(this.deps.activeRequests, traceId);
    const job: Job = { abort, done: Promise.resolve(initial), bytes: 0 };
    this.jobs.set(id, job);
    const emit = async (event: WireItem): Promise<void> => {
      abort.signal.throwIfAborted();
      job.bytes += Buffer.byteLength(JSON.stringify(event));
      if (job.bytes > 25 * 1024 * 1024) throw new ResponseStateError("Response event log exceeds 25 MiB", 413);
      this.repo.addEvent(id, token.id, event);
    };
    this.repo.addEvent(id, token.id, family === "openai_responses" ? { type: "response.created", response: initial } : { type: "hydrogen.session", response_id: id });
    job.done = Promise.resolve().then(async () => {
      let usage = { ...ZERO_USAGE }, calls: unknown = [], attempts = 0, status = 200, error: string | null = null;
      let output = initial;
      let served: InvokeValue | undefined;
      const envelope = { ...initial }; delete envelope.output; delete envelope.status; delete envelope.error; delete envelope.incomplete_details;
      // A declared server tool rules out the live path: it streams the model's
      // turn straight through, which is exactly the turn the round trip has to be
      // synthesized into. Those requests take the buffered path and fabricate
      // their stream, so the client receives the same blocks either way.
      const live = flags.stream && !bound.length && !serverTools.size && family === "openai_responses"
        ? liveResponseWire(service.name, envelope, emit, serviceThinkingFormat(definition), serviceThinkingDelimiters(definition)) : undefined;
      try {
        abort.signal.throwIfAborted();
        this.repo.transition(id, token.id, "in_progress", { ...initial, status: "in_progress" });
        if (family === "openai_responses") await emit({ type: "response.in_progress", response: { ...initial, status: "in_progress" } });
        // Declared server tools are rewritten into the bound tools the model can
        // actually call; every other request is passed through untouched.
        const effective = serverTools.size ? buildRequest(family, { ...request.data(), tools }) : request;
        const run = await runHostedTools(executor, effective, bound, this.deps.transport, { signal: abort.signal, sessionId, config: definition.hostedTools,
          progress, emit: flags.stream ? emit : undefined, onModelEvent: live?.send, thinkingFormat: serviceThinkingFormat(definition), logMaxChars: this.deps.logMaxChars,
          declaredNames: serverTools.size ? new Map([...declaredServerTools(serverTools)].map(([declared, entry]) => [declared, entry.tool.name])) : undefined });
        served = run.value;
        usage = run.value.response.usage; calls = run.calls; attempts = run.attempts;
        abort.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(run.history)) > 25 * 1024 * 1024) throw new ResponseStateError("Response history exceeds 25 MiB", 413);
        let final = run.value.response;
        // Give the client the provider-executed round trips it asked for. The
        // parts come from the run's UNTRUNCATED history, not the clipped trace,
        // and carry no knowledge of any particular tool or adapter.
        if (serverTools.size) {
          const synthesisFamily = family === "openai_responses" ? "openai_responses" as const : family === "anthropic" ? "anthropic" as const : undefined;
          const parts = synthesisFamily ? serverToolParts(collectServerToolCalls(run.history, serverTools), synthesisFamily) : [];
          if (parts.length) {
            // The sequence comes from the history so every round survives, in
            // this wire's order: a text block, the call, its result, the answer.
            // A model that read "search the web" may also answer with the
            // DECLARED name it was never offered (the declaration is replaced by
            // the bound tool, whose form carries the parameters). Such a call
            // reaches no adapter, so it is dropped rather than handed back as
            // something for the client to run.
            const declared = new Set([...serverTools.values()].map(entry => entry.declaration.name));
            const content = serverToolResponseContent(run.history, parts, prefix.length, new Set(run.declined))
              .filter(part => part.type !== "tool_use" || !declared.has(part.name));
            if (content.length) final = buildResponse(family, { ...final.data(), content });
          }
        }
        const response = final.withThinkingFormat(serviceThinkingFormat(definition), serviceThinkingDelimiters(definition));
        const extra: WireItem = { ...initial, status: response.stopReason === "length" ? "incomplete" : "completed", hydrogen: { response_id: id, session_id: sessionId, tool_calls: run.traces } };
        // Let the renderer supply output, usage and incomplete_details; the envelope supplies state fields.
        delete extra.output; delete extra.error; delete extra.incomplete_details;
        const streamed = await live?.close();
        const wire = streamed?.body ? { body: { ...streamed.body, hydrogen: extra.hydrogen }, events: streamed.terminal }
          : await responseWire(response, family, service.name, id, extra, serviceThinkingFormat(definition));
        for (const event of wire.events) if (event.type === "response.completed" || event.type === "response.incomplete") event.response = wire.body;
        abort.signal.throwIfAborted();
        output = wire.body;
        const terminal = wire.events.filter(event => ["response.completed", "response.incomplete", "message_stop"].includes(String(event.type)));
        for (const event of wire.events) if (!terminal.includes(event)) await emit(event);
        if (job.bytes + Buffer.byteLength(JSON.stringify(terminal)) + Buffer.byteLength(JSON.stringify(output)) > 25 * 1024 * 1024) throw new ResponseStateError("Response event log exceeds 25 MiB", 413);
        abort.signal.throwIfAborted();
        const completed = this.repo.transition(id, token.id, response.stopReason === "length" ? "incomplete" : "completed", output, run.history,
          conversationId ? messagesToItems(run.history.slice(prefix.length)) : undefined);
        if (completed) {
          for (const event of terminal) this.repo.addEvent(id, token.id, event);
          if (family === "anthropic") this.repo.addEvent(id, token.id, { type: "hydrogen.response.completed", response: output });
        } else output = this.repo.response(id, token.id)?.response ?? output;
      } catch (caught) {
        await live?.close().catch(() => undefined);
        const cancelled = abort.signal.aborted;
        status = cancelled ? 499 : caught instanceof HostedRunError || caught instanceof ResponseStateError ? caught.statusCode : 502;
        error = cancelled ? "Response execution cancelled" : caught instanceof HostedRunError || caught instanceof ResponseStateError ? caught.message : "Response execution failed";
        if (caught instanceof HostedRunError) { usage = caught.usage; calls = caught.calls; }
        const failed = this.repo.transition(id, token.id, cancelled ? "cancelled" : "failed", { ...initial, error: { code: cancelled ? "cancelled" : "execution_failed", message: error } });
        output = failed?.response ?? this.repo.response(id, token.id)?.response ?? initial;
        if (failed) this.repo.addEvent(id, token.id, { type: family === "anthropic" ? "hydrogen.response.failed" : `response.${failed.status}`, response: output });
      } finally {
        job.status = status; job.error = error;
        const tokenExists = !!this.deps.tokens.get(token.id);
        if (tokenExists) this.deps.usage.record(token.id, usage.totalTokens);
        this.deps.logger.record({ traceId, tokenId: tokenExists ? token.id : null, serviceId: this.deps.services.get(service.id) ? service.id : null, requestedService: service.name, ingress: family, streaming: flags.stream, httpStatus: status, http,
          servedModel: served?.modelName, servedProvider: served?.providerName, egress: served?.family, upstreamPayload: served ? this.deps.logger.capture(served.upstreamRequest) : undefined,
          responseBody: output, usage, latencyMs: Date.now() - started, attempts, attemptPath: calls, error });
        this.deps.activeRequests.finish(traceId, status, error ?? undefined);
        this.jobs.delete(id);
      }
      return output;
    });
    // Streaming and background responses never await this promise. Without a
    // handler attached here, a failure in its bookkeeping (a log write on a
    // full disk, say) would be unhandled and take the process down; the paths
    // that DO await it still observe the rejection.
    job.done.catch(() => undefined);
    if (!flags.background) reply.raw.once("close", () => { if (!reply.raw.writableFinished) abort.abort(); });
    try {
      if (flags.stream) return await this.follow(reply, row);
      if (flags.background) return initial;
      const heartbeat = new JsonKeepalive(reply, this.deps.jsonCommitGraceMs ?? 30_000, this.deps.streamPingIntervalMs ?? 10_000);
      let output;
      try { output = await job.done; } finally { heartbeat.stop(); }
      if ((job.status ?? 200) >= 400) {
        output = { ...buildErrorBody(family, job.status!, job.error ?? "Response execution failed"), hydrogen: { response_id: id } };
        if (!heartbeat.committed) reply.code(job.status!);
      }
      if (heartbeat.finish(output)) return;
      return output;
    } finally {
      if (!flags.store) {
        await job.done;
        this.repo.deleteResponse(id, token.id);
      }
    }
  }

  private async follow(reply: FastifyReply, row: StoredResponse, after = -1): Promise<void> {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
    let lastPing = Date.now();
    try {
      while (!reply.raw.destroyed && !reply.raw.writableEnded) {
        const events = this.repo.events(row.id, row.tokenId, after);
        for (const event of events) {
          if (!reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
            await new Promise<void>(resolve => { const done = () => { reply.raw.off("drain", done); reply.raw.off("close", done); resolve(); }; reply.raw.once("drain", done); reply.raw.once("close", done); });
          }
          after = event.sequence_number as number;
          if (reply.raw.destroyed) break;
        }
        const current = this.repo.state(row.id, row.tokenId);
        if (events.length < 200 && (!current || !active(current) && (!this.jobs.has(row.id) || current.status === "cancelled"))) break;
        if (Date.now() - lastPing > 10_000) { reply.raw.write(": ping\n\n"); lastPing = Date.now(); }
        if (!events.length) await delay(50);
      }
    } finally { if (!reply.raw.destroyed) reply.raw.end(); }
  }
}
