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

function makeTransport(frames: string[], slowDelayMs?: number): Transport {
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
class CapturingLogger implements ProxyDeps["logger"] {
  lastEntry: LogParams | null = null;
  record(p: LogParams): void {
    this.lastEntry = p;
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

  const deps: ProxyDeps = { services, factory, tokens, catalog: fakeCatalog, transport: transport as any, logger, usage, activeRequests };

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
