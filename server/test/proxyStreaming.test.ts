/**
 * Integration test: verify that non-reliable streaming via the real Fastify
 * server delivers the complete SSE response to the client — no truncation.
 *
 * This test deliberately uses Fastify's app.inject() to exercise the full
 * request lifecycle (handler → wrap-thenable → reply.raw) instead of testing
 * at the executor layer like the other test files. The ProxyController.relay()
 * method uses a fire-and-forget async IIFE to write SSE chunks to reply.raw,
 * then returns `reply` from the async handler. If Fastify's wrap-thenable
 * interferes (calling reply.send() before the IIFE finishes), the client
 * would see a truncated response.
 */

import { describe, expect, it, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import "../src/core/format"; // register wire formats
import { ProxyController } from "../src/transport/proxyController";
import type { ProxyDeps } from "../src/transport/deps";
import { ServiceFactory } from "../src/execution/serviceFactory";
import { ActiveRequestRegistry } from "../src/observability/activeRequests";
import type { Transport, TransportJsonResult, TransportStreamResult, TransportOptions } from "../src/core/upstream/transport";
import type { Catalog } from "../src/catalog/catalog";
import type { Family } from "../src/core/format/family";
import type { ModelServiceRow, Token } from "../src/db/schema";
import type { ServiceDef, ServiceSteps } from "../src/execution/definition";
import type { LogParams } from "../src/observability/requestLogger";

// ---------------------------------------------------------------------------
// Fixtures — SSE frames for an OpenAI-compatible upstream
// ---------------------------------------------------------------------------

const OK_FRAMES = [
  'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"hello world this is a test"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n',
  "data: [DONE]\n\n",
];

const readableOf = (frames: string[]): Readable =>
  Readable.from(
    (async function* () {
      for (const chunk of frames) yield chunk;
    })(),
  );

/** A readable that emits frames with a delay (simulating upstream latency). */
function slowReadableOf(frames: string[], delayMs: number): Readable {
  return Readable.from(
    (async function* () {
      for (const chunk of frames) {
        await new Promise((r) => setTimeout(r, delayMs));
        yield chunk;
      }
    })(),
  );
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const fakeCatalog: Catalog = {
  resolve: (model: string, provider: string) => ({
    ok: true,
    target: {
      family: "openai_completion" as Family,
      upstreamModel: `up-${model}`,
      url: "http://upstream",
      headers: {},
      modelName: model,
      providerName: provider,
      upstream: {},
    },
  }),
  exists: () => true,
} as unknown as Catalog;

function makeTransport(frames: string[], slowDelayMs?: number): Transport & Pick<ProxyDeps["transport"], "getJson"> {
  return {
    async postStream(
      _url: string,
      _headers: Record<string, string>,
      _body: unknown,
      _o: TransportOptions,
    ): Promise<TransportStreamResult> {
      const body = slowDelayMs ? slowReadableOf(frames, slowDelayMs) : readableOf(frames);
      return { status: 200, headers: {}, body };
    },
    async postJson(
      _url: string,
      _headers: Record<string, string>,
      _body: unknown,
      _o: TransportOptions,
    ): Promise<TransportJsonResult> {
      return { status: 200, headers: {}, json: {}, text: "" };
    },
    async getJson(
      _url: string,
      _headers: Record<string, string>,
      _o: TransportOptions,
    ): Promise<TransportJsonResult> {
      return { status: 200, headers: {}, json: {}, text: "" };
    },
  };
}

/** A minimal ServiceRepo stub that returns one hardcoded service row. */
function makeServiceRepo(name: string, def: ServiceSteps): Pick<ProxyDeps, "services">["services"] {
  const row: ModelServiceRow = {
    id: 1,
    name,
    description: null,
    kind: "model_service",
    definition: def as unknown,
    enabled: true,
    createdAt: new Date(),
  };
  return {
    list: () => [row],
    get: (id: number) => (id === 1 ? row : undefined),
    getByName: (n: string) => (n === name ? row : undefined),
    def: (_r: ModelServiceRow) => def as ServiceDef,
    create: () => row,
    update: () => row,
    toggle: () => row,
    delete: () => undefined,
  } as unknown as ProxyDeps["services"];
}

/** A minimal TokenRepo stub that authenticates one hardcoded token. */
function makeTokenRepo(): ProxyDeps["tokens"] {
  const token: Token = {
    id: 1,
    name: "test",
    keyHash: "hash",
    keyPrefix: "test",
    keyCiphertext: null,
    keyIv: null,
    keyTag: null,
    ownerUserId: null,
    scopeServices: null,
    maxRequests: null,
    maxTokens: null,
    usedRequests: 0,
    usedTokens: 0,
    expiresAt: null,
    enabled: true,
    createdAt: new Date(),
  };
  return {
    authenticate: (_presented: string) => token,
    incrementUsage: () => undefined,
    toPublic: () => ({
      id: 1, name: "test", keyPrefix: "test", ownerUserId: null,
      scopeServices: null, maxRequests: null, maxTokens: null,
      usedRequests: 0, usedTokens: 0, expiresAt: null, enabled: true,
    }),
  } as unknown as ProxyDeps["tokens"];
}

/** A minimal RequestLogger that captures the last logged entry. */
type LoggerPort = ProxyDeps["logger"];
class CapturingLogger implements Pick<LoggerPort, "record" | "capture"> {
  lastEntry: LogParams | null = null;
  /** Payloads captured early, in call order, so a test can assert that the
   * controller serialized before releasing the object rather than after. */
  captured: string[] = [];
  record(p: LogParams): void {
    this.lastEntry = p;
  }
  capture(value: unknown): string {
    const s = JSON.stringify(value ?? null) ?? "null";
    this.captured.push(s);
    return s;
  }
}

function makeUsageMeter(): ProxyDeps["usage"] {
  return { record: () => undefined } as unknown as ProxyDeps["usage"];
}

function buildApp(
  frames: string[],
  opts?: { slowDelayMs?: number },
): { app: FastifyInstance; logger: CapturingLogger } {
  const def: ServiceSteps = {
    timeoutMs: 30_000,
    steps: [{ model: "m", provider: "p" }],
    // reliableStreaming is intentionally omitted = OFF (direct passthrough)
  };

  const transport = makeTransport(frames, opts?.slowDelayMs);
  const services = makeServiceRepo("svc", def);
  const tokens = makeTokenRepo();
  const activeRequests = new ActiveRequestRegistry();
  const logger = new CapturingLogger();
  const usage = makeUsageMeter();
  const factory = new ServiceFactory(services, { catalog: fakeCatalog, transport, progress: activeRequests }, 10000);

  const deps: ProxyDeps = { services, factory, tokens, catalog: fakeCatalog, transport: transport as any, logger: logger as unknown as LoggerPort, usage, activeRequests };

  const app = Fastify({ logger: false });
  new ProxyController(deps).register(app);
  return { app, logger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProxyController streaming — real Fastify integration", () => {
  let app: FastifyInstance;
  let logger: CapturingLogger;

  beforeEach(() => {
    // recreated per-test below
  });

  async function shutdown(): Promise<void> {
    if (app) await app.close();
  }

  it("non-reliable streaming delivers complete SSE response (fast upstream)", async () => {
    const built = buildApp(OK_FRAMES);
    app = built.app; logger = built.logger;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        payload: { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] },
      });

      const body = res.body;
      // The response must contain all content deltas and [DONE]
      expect(body).toContain("hello world this is a test");
      expect(body).toContain("[DONE]");
      expect(body).toContain("finish_reason");
      // Status should be 200
      expect(res.statusCode).toBe(200);
      // The logger should have recorded a 200 (not 499 or 502)
      expect(logger.lastEntry?.httpStatus).toBe(200);
      expect(logger.lastEntry?.error).toBeNull();
    } finally {
      await shutdown();
    }
  });

  it("non-reliable streaming delivers complete SSE response (slow upstream, 50ms delay)", async () => {
    const built = buildApp(OK_FRAMES, { slowDelayMs: 50 });
    app = built.app; logger = built.logger;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        payload: { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] },
      });

      const body = res.body;
      // Even with upstream latency, the full response must reach the client
      expect(body).toContain("hello world this is a test");
      expect(body).toContain("[DONE]");
      expect(res.statusCode).toBe(200);
      expect(logger.lastEntry?.httpStatus).toBe(200);
      expect(logger.lastEntry?.error).toBeNull();
    } finally {
      await shutdown();
    }
  });

  it("non-reliable streaming delivers complete SSE response (slow upstream, 200ms delay)", async () => {
    // A longer delay increases the chance of hitting the race condition
    // between the async IIFE and Fastify's wrap-thenable
    const built = buildApp(OK_FRAMES, { slowDelayMs: 200 });
    app = built.app; logger = built.logger;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        payload: { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] },
      });

      const body = res.body;
      expect(body).toContain("hello world this is a test");
      expect(body).toContain("[DONE]");
      expect(res.statusCode).toBe(200);
      expect(logger.lastEntry?.httpStatus).toBe(200);
      expect(logger.lastEntry?.error).toBeNull();
    } finally {
      await shutdown();
    }
  });

  it("non-reliable streaming: response body is not empty/truncated", async () => {
    const built = buildApp(OK_FRAMES, { slowDelayMs: 100 });
    app = built.app; logger = built.logger;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        payload: { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] },
      });

      const body = res.body;
      // The body should not be empty
      expect(body.length).toBeGreaterThan(50);
      // Should have multiple data: lines
      const dataLines = body.split("\n").filter((l) => l.startsWith("data:"));
      expect(dataLines.length).toBeGreaterThanOrEqual(3); // start + content + finish + [DONE]
    } finally {
      await shutdown();
    }
  });

  it("non-reliable streaming: no error in logs and content-length not set to 0", async () => {
    // This test specifically checks whether Fastify's wrap-thenable interferes:
    // if reply.send(reply) is called while the IIFE is still running, it would
    // either throw FST_ERR_REP_INVALID_PAYLOAD_TYPE or set content-length: 0.
    const built = buildApp(OK_FRAMES, { slowDelayMs: 150 });
    app = built.app; logger = built.logger;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        payload: { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] },
      });

      // If Fastify truncated the response, content-length would be 0 or the
      // body would be empty / an error JSON
      const body = res.body;
      expect(body).toContain("hello world this is a test");
      expect(body).toContain("[DONE]");
      // content-length should NOT be "0"
      const cl = res.headers["content-length"];
      if (cl !== undefined) {
        expect(Number(cl)).toBeGreaterThan(10);
      }
      // The logger should show 200, no error
      expect(logger.lastEntry?.httpStatus).toBe(200);
      expect(logger.lastEntry?.error).toBeNull();
    } finally {
      await shutdown();
    }
  });

  it("non-reliable streaming: runs 10 requests, all complete without truncation", async () => {
    // Run multiple requests to catch intermittent race conditions
    const built = buildApp(OK_FRAMES, { slowDelayMs: 30 });
    app = built.app; logger = built.logger;
    try {
      const results: { body: string; status: number }[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          payload: { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] },
        });
        results.push({ body: res.body, status: res.statusCode });
      }
      for (const { body, status } of results) {
        expect(status).toBe(200);
        expect(body).toContain("hello world this is a test");
        expect(body).toContain("[DONE]");
      }
    } finally {
      await shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// The same relay, asserted on what the LOG says about it. These run the
// controller's own write loop (the former relay.test.ts checked "logged ==
// delivered" against a local copy of it, which could not fail when the
// controller changed).
// ---------------------------------------------------------------------------

describe("ProxyController relay — the log row matches what the client received", () => {
  const TOOL_FRAMES = [
    'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hello\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n',
    "data: [DONE]\n\n",
  ];
  /** The answer cut off cleanly: no finish_reason, no [DONE]. */
  const TRUNCATED_FRAMES = OK_FRAMES.slice(0, 2);

  const openaiDeltas = (sse: string): string => {
    let text = "";
    for (const frame of sse.split("\n\n")) {
      if (!frame.startsWith("data:") || frame.includes("[DONE]")) continue;
      const delta = (JSON.parse(frame.slice(5)) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    }
    return text;
  };
  const anthropicDeltas = (sse: string): string => {
    let text = "";
    for (const frame of sse.split("\n\n")) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const j = JSON.parse(line.slice(5)) as { type?: string; delta?: { type?: string; text?: string } };
      if (j.type === "content_block_delta" && j.delta?.type === "text_delta") text += j.delta.text ?? "";
    }
    return text;
  };
  /** The relay logs after the response settles, which can trail the client's read. */
  async function logged(logger: CapturingLogger): Promise<LogParams> {
    for (let i = 0; i < 100 && !logger.lastEntry; i++) await new Promise((r) => setTimeout(r, 10));
    if (!logger.lastEntry) throw new Error("the relay never logged");
    return logger.lastEntry;
  }

  it("OpenAI ingress: logged content equals the delivered deltas, with usage and stop reason", async () => {
    const { app, logger } = buildApp(OK_FRAMES);
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        payload: { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      const delivered = openaiDeltas(res.body);
      expect(delivered).toBe("hello world this is a test");

      const entry = await logged(logger);
      expect(entry).toMatchObject({ httpStatus: 200, error: null, streaming: true, ingress: "openai_completion", egress: "openai_completion", attempts: 1 });
      expect(entry.responseBody).toMatchObject({ streamed: true, role: "assistant", content: delivered, stop_reason: "stop" });
      expect(entry.usage).toMatchObject({ promptTokens: 3, completionTokens: 5, totalTokens: 8 });
    } finally {
      await app.close();
    }
  });

  it("Anthropic ingress: the same upstream stream is re-framed, and the log still matches the delivered text", async () => {
    const { app, logger } = buildApp(OK_FRAMES);
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/messages",
        headers: { "x-api-key": "test", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        payload: { model: "svc", stream: true, max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("event: message_start");
      expect(res.body).toContain("event: message_stop");
      expect(res.body).not.toContain("[DONE]");
      const delivered = anthropicDeltas(res.body);
      expect(delivered).toBe("hello world this is a test");

      const entry = await logged(logger);
      expect(entry).toMatchObject({ httpStatus: 200, error: null, ingress: "anthropic", egress: "openai_completion" });
      expect((entry.responseBody as { content: string }).content).toBe(delivered);
    } finally {
      await app.close();
    }
  });

  it("a tool-call stream is delivered whole and logged as a tool call", async () => {
    const { app, logger } = buildApp(TOOL_FRAMES);
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        payload: { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('"name":"lookup"');
      expect(res.body).toContain("[DONE]");

      const entry = await logged(logger);
      expect(entry).toMatchObject({ httpStatus: 200, error: null });
      const body = entry.responseBody as { stop_reason: string; tool_calls: Array<{ name: string }> };
      expect(body.stop_reason).toBe("tool_use");
      expect(body.tool_calls).toHaveLength(1);
      expect(body.tool_calls[0].name).toBe("lookup");
    } finally {
      await app.close();
    }
  });

  it("an upstream stream that ends cleanly without finishing is not terminated like a complete one, and is logged 502", async () => {
    const { app, logger } = buildApp(TRUNCATED_FRAMES);
    try {
      // The controller aborts the connection rather than ending it, so the
      // in-process client may see either a short body or a transport error.
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        payload: { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] },
      }).catch(() => null);
      if (res) {
        expect(res.body).not.toContain("[DONE]");
        expect(res.body).not.toContain('"finish_reason":"stop"');
      }

      const entry = await logged(logger);
      expect(entry.httpStatus).toBe(502);
      expect(entry.error).toBe("upstream stream ended before completion (truncated)");
      expect(entry.responseBody).toMatchObject({ incomplete: true, content: "hello world this is a test" });
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// What the former relay.test.ts asserted of its copied loop and nothing else
// asserted of the controller: reasoning in the log, chunk-by-chunk delivery,
// and independence of consecutive relays.
// ---------------------------------------------------------------------------

describe("ProxyController relay — delivery properties", () => {
  const post = (app: FastifyInstance) => app.inject({
    method: "POST", url: "/v1/chat/completions",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    payload: { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] },
  });
  async function logged(logger: CapturingLogger): Promise<LogParams> {
    for (let i = 0; i < 100 && !logger.lastEntry; i++) await new Promise((r) => setTimeout(r, 10));
    if (!logger.lastEntry) throw new Error("the relay never logged");
    return logger.lastEntry;
  }
  const framesFor = (text: string): string[] => [
    'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
    `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
    "data: [DONE]\n\n",
  ];

  it("a reasoning stream: the trace is delivered and the log records both the trace and the answer", async () => {
    const frames = [
      'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
      ...framesFor("The quick brown fox.").slice(1),
    ];
    const { app, logger } = buildApp(frames);
    try {
      const res = await post(app);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("thinking...");
      expect(res.body).toContain("The quick brown fox.");
      expect(res.body).toContain("[DONE]");
      const entry = await logged(logger);
      expect(entry).toMatchObject({ httpStatus: 200, error: null });
      expect(entry.responseBody).toMatchObject({ content: "The quick brown fox.", reasoning: "thinking...", stop_reason: "stop" });
      expect(entry.usage).toMatchObject({ totalTokens: 3 });
    } finally {
      await app.close();
    }
  });

  it("each chunk reaches the client as it is produced, not when the upstream finishes", async () => {
    // The upstream pauses 300 ms before every frame: the content frame leaves it
    // ~600 ms before the stream ends. A relay that buffered would hand the
    // client everything at once, at the end.
    const DELAY_MS = 300;
    const { app } = buildApp(OK_FRAMES, { slowDelayMs: DELAY_MS });
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const port = (app.server.address() as AddressInfo).port;
      const seen = await new Promise<{ contentAt: number; endAt: number; body: string }>((resolve, reject) => {
        const payload = JSON.stringify({ model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] });
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
          headers: { authorization: "Bearer test", "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
          let body = "", contentAt = 0;
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
            if (!contentAt && body.includes("hello world this is a test")) contentAt = Date.now();
          });
          res.on("end", () => resolve({ contentAt, endAt: Date.now(), body }));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end(payload);
      });
      expect(seen.body).toContain("[DONE]");
      expect(seen.contentAt).toBeGreaterThan(0);
      expect(seen.endAt - seen.contentAt).toBeGreaterThanOrEqual(DELAY_MS);
    } finally {
      await app.close();
    }
  });

  it("consecutive relays each deliver and log their own content (no cross-talk)", async () => {
    const frames = framesFor("first response");
    const { app, logger } = buildApp(frames);
    try {
      const first = await post(app);
      const firstEntry = await logged(logger);
      expect(first.body).toContain("first response");
      expect((firstEntry.responseBody as { content: string }).content).toBe("first response");

      logger.lastEntry = null;
      frames.splice(0, frames.length, ...framesFor("second response"));
      const second = await post(app);
      const secondEntry = await logged(logger);
      expect(second.body).toContain("second response");
      expect(second.body).not.toContain("first response");
      expect((secondEntry.responseBody as { content: string }).content).toBe("second response");
    } finally {
      await app.close();
    }
  });
});
