/**
 * Model Bench, internal transport.
 *
 * The bench exists to answer "does THIS model work", so the properties that
 * matter are the ones a Model Service normally hides: which endpoint was
 * actually called, what body reached it, and what came back -- untranslated by
 * a retry that quietly succeeded somewhere else.
 *
 * The cases below pin exactly that: a raw (model, provider, endpoint) tuple
 * addressed directly, a wire crossing chosen on purpose (openai in, anthropic
 * out), a single attempt with no fallback, and the media passthrough reaching
 * the category's own endpoint rather than the chat one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

const ADMIN_PASSWORD = "bench-test-admin-pass";

interface Hit {
  path: string;
  body: Record<string, unknown>;
}

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let c: any;
let dataDir: string;
let cookie: string;
let hits: Hit[];
let upstream: http.Server;
let baseUrl: string;
/** Flipped per test to make the next upstream answer a failure. */
let failWith: { status: number; body: unknown } | null = null;

/** One server playing every upstream shape; the path says which. */
function startUpstream(): Promise<void> {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const url = req.url ?? "";
        let body: Record<string, unknown> = {};
        try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { body = { _raw: raw.slice(0, 200) }; }
        hits.push({ path: url, body });

        if (failWith) {
          const f = failWith;
          res.writeHead(f.status, { "content-type": "application/json" });
          res.end(JSON.stringify(f.body));
          return;
        }

        // A streamed answer, with the usage riding the terminal chunk exactly
        // as a real provider sends it: last, and after the finish_reason.
        if (body.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (d: Record<string, unknown>): void => {
            res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "up", ...d })}\n\n`);
          };
          chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
          chunk({ choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }] });
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          chunk({
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 9, total_tokens: 109, prompt_tokens_details: { cached_tokens: 70 } },
          });
          res.write("data: [DONE]\n\n");
          return res.end();
        }

        res.writeHead(200, { "content-type": "application/json" });
        if (url.includes("/messages")) {
          res.end(JSON.stringify({
            id: "msg_1", type: "message", role: "assistant", model: "up",
            content: [{ type: "text", text: "pong" }], stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1 },
          }));
        } else if (url.includes("/embeddings")) {
          res.end(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: "up" }));
        } else {
          res.end(JSON.stringify({
            id: "chatcmpl_1", object: "chat.completion", created: 1, model: "up",
            choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 9, total_tokens: 109, prompt_tokens_details: { cached_tokens: 70 } },
          }));
        }
      });
    });
    upstream.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

beforeAll(async () => {
  hits = [];
  await startUpstream();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-bench-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SESSION_SECRET = "bench-test-session-secret-0123456789";

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  c = await boot();

  // One provider serving BOTH wires: primary Chat Completions, plus an
  // Anthropic alternate. That is what makes "which endpoint" a real question.
  const provider = c.providers.create({
    name: "dual",
    type: "openai_completion",
    baseUrl: `${baseUrl}/chat/v1`,
    apiKey: "k",
    altEndpoints: [{ type: "anthropic", baseUrl: `${baseUrl}/anthropic/v1` }],
  });
  const model = c.models.create({ name: "m1" });
  c.mappings.create({
    modelId: model.id,
    providerId: provider.id,
    upstreamModel: "up",
    families: ["openai_completion", "anthropic"],
  });
  c.services.create({ name: "svc", definition: { timeoutMs: 10_000, steps: [{ model: "m1", provider: "dual" }] } });
  c.services.create({
    name: "emb",
    definition: { timeoutMs: 10_000, category: "embedding", steps: [{ model: "m1", provider: "dual" }] },
  });

  app = await buildApp(c);
  const res = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  const session = res.cookies.find((x) => x.name === "hydrogen_session")!;
  cookie = `${session.name}=${session.value}`;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  c.sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as never, headers: { cookie } });

const CHAT_BODY = { model: "x", messages: [{ role: "user", content: "ping" }] };

describe("the target picker offers only combinations that can resolve", () => {
  it("lists services with their category and kind, and mappings with their reachable endpoints", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/bench/targets", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      services: Array<{ name: string; category: string; kind: string; valid: boolean }>;
      mappings: Array<{ model: string; provider: string; families: string[]; upstreamModel: string }>;
    };
    expect(body.services.find((s) => s.name === "svc")).toMatchObject({ category: "chat", kind: "model_service", valid: true });
    expect(body.services.find((s) => s.name === "emb")).toMatchObject({ category: "embedding" });
    const mapping = body.mappings.find((m) => m.model === "m1" && m.provider === "dual")!;
    expect(mapping.upstreamModel).toBe("up");
    // Both endpoints, primary first -- the picker's "provider format" options.
    expect(mapping.families).toEqual(["openai_completion", "anthropic"]);
  });
});

describe("a raw tuple is addressed directly, endpoint and all", () => {
  it("reaches the provider's PRIMARY endpoint when that format is chosen", async () => {
    hits = [];
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "openai_completion" },
      ingress: "openai_completion",
      body: CHAT_BODY,
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { ok: boolean; served: { family: string }; response: Record<string, unknown> };
    expect(out.ok).toBe(true);
    expect(out.served.family).toBe("openai_completion");
    expect(hits[0].path).toContain("/chat/v1");
    expect(JSON.stringify(out.response)).toContain("pong");
  });

  it("reaches the ALTERNATE endpoint when that format is chosen instead", async () => {
    hits = [];
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "anthropic" },
      ingress: "openai_completion",
      body: CHAT_BODY,
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { ok: boolean; served: { family: string }; upstreamRequest: Record<string, unknown> };
    expect(out.ok).toBe(true);
    expect(out.served.family).toBe("anthropic");
    expect(hits[0].path).toContain("/anthropic/v1");
    // The crossing actually happened: an OpenAI body went out as an Anthropic one.
    expect(out.upstreamRequest.messages).toBeDefined();
    expect(out.upstreamRequest.model).toBe("up");
  });

  it("the answer is rendered back into the wire the bench spoke, not the one the provider used", async () => {
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "anthropic" },
      ingress: "openai_completion",
      body: CHAT_BODY,
    });
    const out = res.json() as { response: Record<string, unknown> };
    // An Anthropic upstream answered; an OpenAI client asked.
    expect(out.response.object).toBe("chat.completion");
    expect(out.response.choices).toBeDefined();
  });

  it("makes exactly ONE attempt -- a bench must not hide a failure behind a retry", async () => {
    hits = [];
    failWith = { status: 429, body: { error: { message: "slow down" } } };
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "openai_completion" },
      ingress: "openai_completion",
      body: CHAT_BODY,
    });
    failWith = null;
    const out = res.json() as { ok: boolean; status: number; message: string; attemptPath: Array<Record<string, unknown>> };
    expect(out.ok).toBe(false);
    expect(out.status).toBe(429);
    expect(hits.length).toBe(1);
    expect(out.attemptPath).toHaveLength(1);
    // The provider's own words, not just "upstream returned 429".
    expect(out.message).toBe("slow down");
    expect(out.attemptPath[0].upstreamError).toBe("slow down");
  });

  it("says which endpoint is missing rather than misrouting the request", async () => {
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "openai_responses" },
      ingress: "openai_completion",
      body: CHAT_BODY,
    });
    const out = res.json() as { ok: boolean; message: string };
    expect(out.ok).toBe(false);
    expect(out.message).toContain("openai_responses");
  });
});

describe("a saved service runs exactly as production runs it", () => {
  it("returns the upstream body and the attempt path alongside the answer", async () => {
    const svc = c.services.getByName("svc");
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "service", serviceId: svc.id },
      ingress: "anthropic",
      body: { model: "x", max_tokens: 64, messages: [{ role: "user", content: "ping" }] },
    });
    const out = res.json() as {
      ok: boolean;
      served: { model: string; provider: string };
      upstreamRequest: Record<string, unknown>;
      attemptPath: unknown[];
      response: Record<string, unknown>;
      usage: Record<string, number>;
    };
    expect(out.ok).toBe(true);
    expect(out.served).toMatchObject({ model: "m1", provider: "dual" });
    expect(out.upstreamRequest.model).toBe("up");
    expect(out.attemptPath).toHaveLength(1);
    // Asked in Anthropic, so answered in Anthropic.
    expect(out.response.type).toBe("message");
    expect(out.usage.totalTokens).toBeGreaterThan(0);
  });

  it("refuses a media service on the chat panel, and names where it belongs", async () => {
    const emb = c.services.getByName("emb");
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "service", serviceId: emb.id },
      ingress: "openai_completion",
      body: CHAT_BODY,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("embedding");
  });
});

describe("media categories reach their own endpoint", () => {
  it("an embedding run posts to /embeddings, not the chat route", async () => {
    hits = [];
    const res = await post("/admin/api/bench/media", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "openai_completion" },
      category: "embedding",
      body: { model: "x", input: "hello" },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { ok: boolean; upstreamRequest: Record<string, unknown>; response: Record<string, unknown> };
    expect(out.ok).toBe(true);
    expect(hits[0].path).toContain("/embeddings");
    // The bench's placeholder model name is replaced by the mapped one.
    expect(out.upstreamRequest.model).toBe("up");
    expect(out.response.data).toBeDefined();
  });

  it("an Anthropic endpoint is refused for a media category instead of being posted to", async () => {
    const res = await post("/admin/api/bench/media", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "anthropic" },
      category: "embedding",
      body: { model: "x", input: "hello" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("anthropic");
  });

  it("speech-to-text needs the recording it is meant to transcribe", async () => {
    const res = await post("/admin/api/bench/media", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "openai_completion" },
      category: "stt",
      body: { model: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("audio");
  });
});

describe("a streamed run reports its tokens, like a buffered one", () => {
  /**
   * Usage rides the terminal event, which the serializer consumes on its way to
   * the client -- so unless it is tapped in passing, a streamed bench run shows
   * no counts at all. Beside a buffered run that shows all of them, that reads
   * as the proxy having lost them somewhere.
   */
  it("the trailing bench frame carries usage, cached share included", async () => {
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "openai_completion" },
      ingress: "openai_completion",
      body: { ...CHAT_BODY, stream: true },
    });
    expect(res.statusCode).toBe(200);
    const metaLine = res.payload
      .split("\n\n")
      .find((f) => f.startsWith("event: bench"))!
      .split("\n")
      .find((l) => l.startsWith("data:"))!;
    const meta = JSON.parse(metaLine.slice(5)) as { ok: boolean; usage?: Record<string, number> };
    expect(meta.ok).toBe(true);
    expect(meta.usage).toBeDefined();
    expect(meta.usage!.promptTokens).toBe(100);
    expect(meta.usage!.completionTokens).toBe(9);
    expect(meta.usage!.cachedInputTokens).toBe(70);
  });

  it("a buffered run of the same request reports the same numbers", async () => {
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "openai_completion" },
      ingress: "openai_completion",
      body: CHAT_BODY,
    });
    const out = res.json() as { usage: Record<string, number> };
    expect(out.usage.promptTokens).toBe(100);
    expect(out.usage.cachedInputTokens).toBe(70);
  });
});

describe("a bench run stays out of the traffic it is diagnosing", () => {
  it("writes no request log and spends no key quota", async () => {
    const before = c.logs.query({ limit: 1 }).total as number;
    await post("/admin/api/bench/chat", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "openai_completion" },
      ingress: "openai_completion",
      body: CHAT_BODY,
    });
    expect(c.logs.query({ limit: 1 }).total).toBe(before);
  });
});
