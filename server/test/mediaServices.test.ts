/**
 * Non-chat service categories (image / video / tts / stt / embedding / rerank):
 * OpenAI-style passthrough endpoints with the step chain's retry/fallback, and
 * the Micro Agent restriction — a non-chat service must be rejected both at
 * save-time validation and by the runtime resolver.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

type UpstreamHandler = (req: CapturedRequest, res: http.ServerResponse) => void;

interface EchoUpstream {
  baseUrl: string;
  requests: CapturedRequest[];
  /** Replace the response behavior for subsequent requests. */
  setHandler: (h: UpstreamHandler) => void;
  close: () => Promise<void>;
}

/** A minimal upstream that records every raw request and answers via a swappable handler. */
function startEchoUpstream(): Promise<EchoUpstream> {
  const requests: CapturedRequest[] = [];
  let handler: UpstreamHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const captured = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(captured);
      handler(captured, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        setHandler: (h) => { handler = h; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const jsonHandler = (status: number, body: unknown): UpstreamHandler => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

let app: FastifyInstance;
let upstream: EchoUpstream;
let dataDir: string;
let secret: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let c: any;
let embServiceId = 0;
let videoServiceId = 0;
let providerId = 0;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-media-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "media-test-password";
  process.env.SESSION_SECRET = "media-test-session-secret";

  upstream = await startEchoUpstream();

  const { boot: bootContainer } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  c = await bootContainer();

  const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  providerId = provider.id;
  const anthropicProvider = c.providers.create({ name: "anthro", type: "anthropic", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" });
  const model = c.models.create({ name: "m1" });
  c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "real-model" });
  c.mappings.create({ modelId: model.id, providerId: anthropicProvider.id, upstreamModel: "claude-x" });

  const mk = (name: string, definition: unknown): { id: number } => c.services.create({ name, definition });
  embServiceId = mk("emb", { category: "embedding", timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] }).id;
  mk("img", {
    category: "image", timeoutMs: 10_000,
    steps: [{ model: "m1", provider: "fake", retry: { maxAttempts: 2, on: [503], intervalMs: 0 } }],
  });
  mk("reranker", { category: "rerank", timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] });
  mk("tts-svc", { category: "tts", timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] });
  mk("stt-svc", { category: "stt", timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] });
  videoServiceId = mk("video-svc", { category: "video", timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] }).id;
  mk("chat-svc", { timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] });
  mk("ocr-svc", { category: "ocr", timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] });

  secret = c.tokens.create({ name: "t" }).secret;
  app = await buildApp(c);
});

afterAll(async () => {
  await app.close();
  await upstream.close();
  c.sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${secret}` });

describe("service category schema & validation", () => {
  it("a media category is accepted and shows in the summary", () => {
    const row = c.services.getByName("emb");
    const { summary } = c.validator.validate(row.definition);
    expect(summary).toContain("[embedding]");
  });

  it("a Micro Agent stage may NOT reference a non-chat service", () => {
    expect(() =>
      c.validator.validate({
        kind: "micro_agent", timeoutMs: 10_000,
        stages: [{ name: "s1", service: "emb", input: [] }],
      }),
    ).toThrowError(/embedding service — only chat\/OCR services can run inside a Micro Agent/);
  });

  it("an OCR reference to a non-chat service is rejected", () => {
    expect(() =>
      c.validator.validate({
        kind: "micro_agent", timeoutMs: 10_000,
        stages: [{ name: "s1", service: "chat-svc", input: [] }],
        ocr: { service: "emb" },
      }),
    ).toThrowError(/a embedding service — it must be a chat or OCR Model Service/);
  });

  it("a chat service reference is still allowed", () => {
    const { def } = c.validator.validate({
      kind: "micro_agent", timeoutMs: 10_000,
      stages: [{ name: "s1", service: "chat-svc", input: [] }],
    });
    expect(def.stages).toHaveLength(1);
  });

  it("a non-chat service on an Anthropic provider is rejected", () => {
    expect(() =>
      c.validator.validate({ category: "image", timeoutMs: 10_000, steps: [{ model: "m1", provider: "anthro" }] }),
    ).toThrowError(/image services require an OpenAI-compatible provider/);
  });

  it("the runtime resolver refuses a non-chat service (defense in depth)", () => {
    const res = c.factory.resolve("emb");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/embedding service and cannot run inside a Micro Agent/);
  });

  // --- ocr: a chat-pipeline category, not a media passthrough ---------------

  it("ocr category is accepted and shows in the summary", () => {
    const { summary } = c.validator.validate({ category: "ocr", timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] });
    expect(summary).toContain("[ocr]");
  });

  it("a Micro Agent stage MAY reference an ocr service", () => {
    const { def } = c.validator.validate({
      kind: "micro_agent", timeoutMs: 10_000,
      stages: [{ name: "s1", service: "ocr-svc", input: [] }],
    });
    expect(def.stages).toHaveLength(1);
  });

  it("the image-translation (OCR) pre-pass may reference an ocr service", () => {
    const { def } = c.validator.validate({
      kind: "micro_agent", timeoutMs: 10_000,
      stages: [{ name: "s1", service: "chat-svc", input: [] }],
      ocr: { service: "ocr-svc" },
    });
    expect(def.ocr.service).toBe("ocr-svc");
  });

  it("an ocr service on an Anthropic provider is allowed (translated chat pipeline)", () => {
    const { summary } = c.validator.validate({ category: "ocr", timeoutMs: 10_000, steps: [{ model: "m1", provider: "anthro" }] });
    expect(summary).toContain("[ocr]");
  });

  it("the runtime resolver accepts an ocr service inside a Micro Agent", () => {
    const res = c.factory.resolve("ocr-svc");
    expect(res.ok).toBe(true);
  });
});

describe("endpoint/category routing", () => {
  it("a chat request to a media service is rejected with a pointer to its endpoint", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: auth(),
      payload: { model: "emb", messages: [{ role: "user", content: "hi" }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("embedding service");
  });

  it("a media endpoint rejects a service of another category", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/embeddings", headers: auth(), payload: { model: "chat-svc", input: "x" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("/v1/chat/completions");
  });

  it("requires a client token", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/embeddings", payload: { model: "emb", input: "x" } });
    expect(r.statusCode).toBe(401);
  });

  it("a media endpoint rejects an ocr service with a pointer to chat completions", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/embeddings", headers: auth(), payload: { model: "ocr-svc", input: "x" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("/v1/chat/completions");
  });

  it("the chat endpoint serves an ocr service through the chat pipeline", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(jsonHandler(200, {
      id: "cmpl-1", object: "chat.completion", model: "real-model",
      choices: [{ index: 0, message: { role: "assistant", content: "extracted text" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
    const r = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: auth(),
      payload: { model: "ocr-svc", messages: [{ role: "user", content: "read this image" }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().choices[0].message.content).toBe("extracted text");
    const sent = JSON.parse(upstream.requests[0].body.toString());
    expect(sent.model).toBe("real-model");
  });
});

describe("JSON passthrough (embedding / rerank / image / video)", () => {
  it("embeddings: model is swapped to the upstream name and usage is recorded", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(jsonHandler(200, { object: "list", data: [], usage: { prompt_tokens: 7, total_tokens: 7 } }));
    const r = await app.inject({ method: "POST", url: "/v1/embeddings", headers: auth(), payload: { model: "emb", input: "hello" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().usage.prompt_tokens).toBe(7);
    const sent = JSON.parse(upstream.requests[0].body.toString());
    expect(upstream.requests[0].url).toBe("/v1/embeddings");
    expect(sent.model).toBe("real-model");
    expect(sent.input).toBe("hello");
    expect(upstream.requests[0].headers.authorization).toBe("Bearer k");
  });

  it("rerank hits /v1/rerank", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(jsonHandler(200, { results: [] }));
    const r = await app.inject({
      method: "POST", url: "/v1/rerank", headers: auth(),
      payload: { model: "reranker", query: "q", documents: ["a", "b"] },
    });
    expect(r.statusCode).toBe(200);
    expect(upstream.requests[0].url).toBe("/v1/rerank");
    expect(JSON.parse(upstream.requests[0].body.toString()).model).toBe("real-model");
  });

  it("image generation retries per the step's rules (503 then 200)", async () => {
    upstream.requests.length = 0;
    let calls = 0;
    upstream.setHandler((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "busy" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ url: "http://img" }] }));
    });
    const r = await app.inject({
      method: "POST", url: "/v1/images/generations", headers: auth(),
      payload: { model: "img", prompt: "a cat", size: "512x512" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data[0].url).toBe("http://img");
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[0].url).toBe("/v1/images/generations");
  });

  it("video create suffixes the job id; polling strips it and re-applies it", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(jsonHandler(200, { id: "video_abc", status: "queued" }));
    const created = await app.inject({
      method: "POST", url: "/v1/videos", headers: auth(),
      payload: { model: "video-svc", prompt: "a dog" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    expect(id).toBe(`video_abc-h${videoServiceId}x${providerId}`);

    upstream.setHandler(jsonHandler(200, { id: "video_abc", status: "completed" }));
    const polled = await app.inject({ method: "GET", url: `/v1/videos/${id}`, headers: auth() });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().status).toBe("completed");
    expect(polled.json().id).toBe(id); // suffix re-applied so the client keeps using it
    expect(upstream.requests[1].url).toBe("/v1/videos/video_abc"); // suffix stripped upstream
  });

  it("polling an unsuffixed id is a clean 404", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/videos/video_raw", headers: auth() });
    expect(r.statusCode).toBe(404);
  });
});

describe("TTS (binary out) and STT (multipart in)", () => {
  it("tts streams the upstream audio bytes through", async () => {
    upstream.requests.length = 0;
    const audio = Buffer.from("FAKE-MP3-BYTES");
    upstream.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(audio);
    });
    const r = await app.inject({
      method: "POST", url: "/v1/audio/speech", headers: auth(),
      payload: { model: "tts-svc", input: "hello", voice: "alloy" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("audio/mpeg");
    expect(r.rawPayload.equals(audio)).toBe(true);
    expect(upstream.requests[0].url).toBe("/v1/audio/speech");
    expect(JSON.parse(upstream.requests[0].body.toString()).model).toBe("real-model");
  });

  it("stt forwards the multipart verbatim with only the model field rewritten", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(jsonHandler(200, { text: "hello world" }));
    const boundary = "----hydrogenTestBoundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      "",
      "stt-svc",
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="a.wav"',
      "Content-Type: audio/wav",
      "",
      "RIFF-FAKE-AUDIO-DATA",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const r = await app.inject({
      method: "POST", url: "/v1/audio/transcriptions",
      headers: { ...auth(), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().text).toBe("hello world");
    const forwarded = upstream.requests[0].body.toString();
    expect(upstream.requests[0].url).toBe("/v1/audio/transcriptions");
    expect(upstream.requests[0].headers["content-type"]).toContain(boundary);
    expect(forwarded).toContain('name="model"');
    expect(forwarded).toContain("real-model");
    expect(forwarded).not.toContain("stt-svc"); // the service name never leaks upstream
    expect(forwarded).toContain("RIFF-FAKE-AUDIO-DATA"); // file part untouched
  });
});
