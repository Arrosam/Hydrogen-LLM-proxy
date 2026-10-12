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
  /** The request body exactly as received (a multipart form is not JSON). */
  raw: string;
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
/** Flipped per test to make the upstream hang up without answering. */
let dropConnection = false;
/** What the fake speech endpoint answers with. */
const SPEECH_BYTES = Buffer.from("FAKE-MP3-BYTES");

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
        hits.push({ path: url, body, raw });

        if (dropConnection) {
          res.destroy();
          return;
        }

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

        if (url.includes("/audio/speech")) {
          res.writeHead(200, { "content-type": "audio/mpeg" });
          return res.end(SPEECH_BYTES);
        }

        res.writeHead(200, { "content-type": "application/json" });
        if (url.includes("/audio/transcriptions")) {
          res.end(JSON.stringify({ text: "hello world" }));
        } else if (url.includes("/messages")) {
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

// --- guards, failure frames and the remaining media shapes -------------------

const RAW_CHAT = { kind: "raw", model: "m1", provider: "dual", providerFormat: "openai_completion" } as const;
const RAW_MEDIA = RAW_CHAT;

/** SSE frames of a streamed bench run, and the payload of its trailing `bench` frame. */
function benchFrames(payload: string): { frames: string[]; meta: Record<string, unknown> } {
  const frames = payload.split("\n\n").filter((f) => f.trim() !== "");
  const bench = frames.filter((f) => f.startsWith("event: bench"));
  expect(bench).toHaveLength(1);
  // Always the last thing on the wire: nothing follows the bench's own summary.
  expect(frames[frames.length - 1]).toBe(bench[0]);
  const data = bench[0].split("\n").find((l) => l.startsWith("data:"))!;
  return { frames, meta: JSON.parse(data.slice(5)) as Record<string, unknown> };
}

describe("chat bench request guards", () => {
  it("an unknown service id is a 404", async () => {
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "service", serviceId: 99_999 },
      ingress: "openai_completion",
      body: CHAT_BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Model Service not found" });
  });

  it("a body the chosen wire's parser refuses is a 400 naming that wire and the reason", async () => {
    hits = [];
    const res = await post("/admin/api/bench/chat", {
      target: RAW_CHAT,
      ingress: "anthropic",
      body: {
        model: "x", max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "document", source: { type: "base64" } }] }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "body is not a valid anthropic request: Anthropic base64 document source is missing data",
    });
    expect(hits).toHaveLength(0);
  });

  it("the wire parsers are lenient: a body with no messages is still run, not refused", async () => {
    hits = [];
    const res = await post("/admin/api/bench/chat", {
      target: RAW_CHAT,
      ingress: "anthropic",
      body: { model: "x", max_tokens: 64 },
    });
    expect(res.statusCode).toBe(200);
    expect(hits).toHaveLength(1);
    expect(hits[0].body.messages).toEqual([]);
  });

  it("a timeout below the one-second floor is rejected by the schema", async () => {
    hits = [];
    const res = await post("/admin/api/bench/chat", {
      target: RAW_CHAT,
      ingress: "openai_completion",
      body: CHAT_BODY,
      timeoutMs: 999,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("timeoutMs");
    expect(hits).toHaveLength(0);
  });

  it("requires an admin session", async () => {
    const res = await app.inject({
      method: "POST", url: "/admin/api/bench/chat",
      payload: { target: RAW_CHAT, ingress: "openai_completion", body: CHAT_BODY },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("streamed bench runs", () => {
  it("a saved service streams the client's own frames, then one bench frame with usage and the attempt path", async () => {
    hits = [];
    const svc = c.services.getByName("svc");
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "service", serviceId: svc.id },
      ingress: "openai_completion",
      body: { ...CHAT_BODY, stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    const { frames, meta } = benchFrames(res.payload);
    expect(frames.length).toBeGreaterThan(1);
    expect(res.payload).toContain("pong");
    expect(meta).toMatchObject({
      ok: true,
      status: 200,
      served: { model: "m1", provider: "dual", family: "openai_completion", upstreamModel: "up" },
      usage: { promptTokens: 100, completionTokens: 9, cachedInputTokens: 70 },
    });
    expect((meta.upstreamRequest as Record<string, unknown>).model).toBe("up");
    expect(meta.attemptPath).toHaveLength(1);
    expect(hits).toHaveLength(1);
  });

  it("a saved service whose upstream fails yields a single failing bench frame", async () => {
    hits = [];
    failWith = { status: 500, body: { error: { message: "boom" } } };
    const svc = c.services.getByName("svc");
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "service", serviceId: svc.id },
      ingress: "openai_completion",
      body: { ...CHAT_BODY, stream: true },
    });
    failWith = null;
    // The stream was already committed, so the failure travels in the frame.
    expect(res.statusCode).toBe(200);
    const { frames, meta } = benchFrames(res.payload);
    expect(frames).toHaveLength(1);
    expect(meta).toMatchObject({ ok: false, status: 500, message: "boom" });
    expect(meta.attemptPath).toHaveLength(1);
    expect(hits).toHaveLength(1);
  });

  it("a raw tuple with no such endpoint yields a single bench frame with the buffered run's status (502)", async () => {
    hits = [];
    const res = await post("/admin/api/bench/chat", {
      target: { kind: "raw", model: "m1", provider: "dual", providerFormat: "openai_responses" },
      ingress: "openai_completion",
      body: { ...CHAT_BODY, stream: true },
    });
    expect(res.statusCode).toBe(200);
    const { frames, meta } = benchFrames(res.payload);
    expect(frames).toHaveLength(1);
    expect(meta).toMatchObject({ ok: false, status: 502 });
    expect(meta.message).toContain("openai_responses");
    expect(meta.attemptPath).toHaveLength(1);
    expect(hits).toHaveLength(0);
  });

  it("a raw tuple whose upstream refuses yields a single bench frame with the upstream status and message", async () => {
    hits = [];
    failWith = { status: 429, body: { error: { message: "slow down" } } };
    const res = await post("/admin/api/bench/chat", {
      target: RAW_CHAT,
      ingress: "openai_completion",
      body: { ...CHAT_BODY, stream: true },
    });
    failWith = null;
    const { frames, meta } = benchFrames(res.payload);
    expect(frames).toHaveLength(1);
    expect(meta).toMatchObject({ ok: false, status: 429, message: "slow down", served: { family: "openai_completion" } });
    expect(hits).toHaveLength(1);
  });
});

describe("media bench request guards", () => {
  it("a chat-pipeline category is sent back to the chat panel", async () => {
    for (const category of ["chat", "ocr"]) {
      const res = await post("/admin/api/bench/media", { target: RAW_MEDIA, category, body: { model: "x" } });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain("chat-pipeline category");
    }
  });

  it("an unknown service id is a 404", async () => {
    const res = await post("/admin/api/bench/media", {
      target: { kind: "service", serviceId: 99_999 },
      category: "embedding",
      body: { model: "x", input: "hello" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Model Service not found" });
  });

  it("a Micro Agent has no media endpoint", async () => {
    const agent = c.services.create({
      name: "bench-agent",
      definition: { kind: "micro_agent", timeoutMs: 10_000, stages: [{ name: "s1", service: "svc", input: [] }] },
    });
    const res = await post("/admin/api/bench/media", {
      target: { kind: "service", serviceId: agent.id },
      category: "embedding",
      body: { model: "x", input: "hello" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: '"bench-agent" is a Micro Agent; it has no media endpoint' });
  });

  it("a service of another category is refused, naming both categories", async () => {
    hits = [];
    const emb = c.services.getByName("emb");
    const res = await post("/admin/api/bench/media", {
      target: { kind: "service", serviceId: emb.id },
      category: "rerank",
      body: { model: "x", query: "q", documents: ["a"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: '"emb" is a embedding service, not rerank' });
    expect(hits).toHaveLength(0);
  });

  it("a timeout below the one-second floor is rejected by the schema", async () => {
    const res = await post("/admin/api/bench/media", {
      target: RAW_MEDIA,
      category: "embedding",
      body: { model: "x", input: "hello" },
      timeoutMs: 999,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("timeoutMs");
  });
});

describe("media bench runs", () => {
  it("a saved media service is run through its own mapping", async () => {
    hits = [];
    const emb = c.services.getByName("emb");
    const res = await post("/admin/api/bench/media", {
      target: { kind: "service", serviceId: emb.id },
      category: "embedding",
      body: { model: "x", input: "hello" },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { ok: boolean; served: Record<string, unknown>; upstreamRequest: Record<string, unknown> };
    expect(out.ok).toBe(true);
    expect(out.served).toMatchObject({ model: "m1", provider: "dual", family: "openai_completion", upstreamModel: "up" });
    expect(out.upstreamRequest).toEqual({ model: "up", input: "hello" });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("/chat/v1/embeddings");
  });

  it("a saved media service gets one shot at its first step: no retry, no fallback", async () => {
    const chain = c.services.create({
      name: "emb-chain",
      definition: {
        timeoutMs: 10_000, category: "embedding",
        steps: [
          { model: "m1", provider: "dual", retry: { maxAttempts: 3, on: [503], intervalMs: 0 } },
          { model: "m1", provider: "dual" },
        ],
      },
    });
    hits = [];
    failWith = { status: 503, body: { error: { message: "busy" } } };
    const res = await post("/admin/api/bench/media", {
      target: { kind: "service", serviceId: chain.id },
      category: "embedding",
      body: { model: "x", input: "hello" },
    });
    failWith = null;
    expect(res.json()).toMatchObject({ ok: false, status: 503, message: "busy" });
    expect(hits).toHaveLength(1);
  });

  it("an upstream refusal comes back in-body: HTTP 200 with ok:false and the upstream's status and words", async () => {
    hits = [];
    failWith = { status: 400, body: { error: { message: "bad input" } } };
    const res = await post("/admin/api/bench/media", {
      target: RAW_MEDIA,
      category: "embedding",
      body: { model: "x", input: "hello" },
    });
    failWith = null;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: false,
      status: 400,
      message: "bad input",
      served: { model: "m1", provider: "dual", upstreamModel: "up" },
      upstreamRequest: { model: "up", input: "hello" },
      response: { error: { message: "bad input" } },
    });
    expect(hits).toHaveLength(1);
  });

  it("a connection that dies is reported as status 0, not as an HTTP error", async () => {
    hits = [];
    dropConnection = true;
    let res;
    try {
      res = await post("/admin/api/bench/media", {
        target: RAW_MEDIA,
        category: "embedding",
        body: { model: "x", input: "hello" },
      });
    } finally {
      dropConnection = false;
    }
    expect(res.statusCode).toBe(200);
    const out = res.json() as { ok: boolean; status: number; message: string; served: Record<string, unknown> };
    expect(out.ok).toBe(false);
    expect(out.status).toBe(0);
    expect(out.message).toBeTruthy();
    expect(out.served).toMatchObject({ model: "m1", provider: "dual" });
    expect(hits).toHaveLength(1); // one attempt, as everywhere in the bench
  });

  it("a text-to-speech run returns the audio itself, base64 with its media type", async () => {
    hits = [];
    const res = await post("/admin/api/bench/media", {
      target: RAW_MEDIA,
      category: "tts",
      body: { model: "x", input: "hello", voice: "alloy" },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { ok: boolean; status: number; audio: Record<string, unknown>; upstreamRequest: Record<string, unknown> };
    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.audio).toEqual({ mediaType: "audio/mpeg", bytes: SPEECH_BYTES.length, base64: SPEECH_BYTES.toString("base64") });
    expect(out.upstreamRequest).toEqual({ model: "up", input: "hello", voice: "alloy" });
    expect(hits[0].path).toBe("/chat/v1/audio/speech");
    expect(hits[0].body.model).toBe("up");
  });

  it("a text-to-speech refusal reports the upstream's status and message instead of audio", async () => {
    failWith = { status: 400, body: { error: { message: "voice not found" } } };
    const res = await post("/admin/api/bench/media", {
      target: RAW_MEDIA,
      category: "tts",
      body: { model: "x", input: "hello", voice: "nope" },
    });
    failWith = null;
    const out = res.json() as Record<string, unknown>;
    expect(out).toMatchObject({ ok: false, status: 400, message: "voice not found" });
    expect(out.audio).toBeUndefined();
  });

  it("a speech-to-text run frames the recording as multipart, with the mapped model name", async () => {
    hits = [];
    const audio = Buffer.from("RIFF-FAKE-AUDIO-DATA");
    const res = await post("/admin/api/bench/media", {
      target: RAW_MEDIA,
      category: "stt",
      body: { model: "x", language: "en" },
      file: { name: "a.wav", mediaType: "audio/wav", data: audio.toString("base64") },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { ok: boolean; response: Record<string, unknown>; upstreamRequest: Record<string, unknown> };
    expect(out.ok).toBe(true);
    expect(out.response).toEqual({ text: "hello world" });
    // The file is summarized in the report, never echoed back.
    expect(out.upstreamRequest).toEqual({ model: "up", language: "en", file: `(a.wav, audio/wav, ${audio.length} bytes)` });

    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("/chat/v1/audio/transcriptions");
    const form = hits[0].raw;
    expect(form).toContain('name="model"\r\n\r\nup\r\n');
    expect(form).toContain('name="language"\r\n\r\nen\r\n');
    expect(form).toContain('name="file"; filename="a.wav"');
    expect(form).toContain("RIFF-FAKE-AUDIO-DATA");
    expect(form).not.toContain('\r\n\r\nx\r\n'); // the bench's placeholder model never goes upstream
  });
});
