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
  mk("img-params", {
    category: "image", timeoutMs: 10_000,
    steps: [{
      model: "m1", provider: "fake", retry: { maxAttempts: 2, on: [503], intervalMs: 0 },
      overrides: { extra: { quality: "high", n: 2, output_format: "webp", model: "hijacked-model" } },
    }],
  });
  const fallbackModel = c.models.create({ name: "m2" });
  c.mappings.create({ modelId: fallbackModel.id, providerId: provider.id, upstreamModel: "fallback-model" });
  mk("img-fallback", {
    category: "image", timeoutMs: 10_000,
    steps: [
      { model: "m1", provider: "fake", retry: { maxAttempts: 1 }, overrides: { extra: { quality: "high" } } },
      { model: "m2", provider: "fake", retry: { maxAttempts: 1 }, overrides: { extra: { size: "1024x1024" } } },
    ],
  });
  mk("reranker", { category: "rerank", timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] });
  mk("tts-svc", { category: "tts", timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] });
  mk("stt-svc", { category: "stt", timeoutMs: 10_000, steps: [{ model: "m1", provider: "fake" }] });
  mk("stt-params", {
    category: "stt", timeoutMs: 10_000,
    steps: [{
      model: "m1", provider: "fake",
      overrides: { extra: { language: "ja", temperature: 0, timestamp_granularities: ["word"], model: "hijacked-model" } },
    }],
  });
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

  it("a non-chat service on an Anthropic-only provider is rejected", () => {
    expect(() =>
      c.validator.validate({ category: "image", timeoutMs: 10_000, steps: [{ model: "m1", provider: "anthro" }] }),
    ).toThrowError(/image services require an OpenAI-compatible endpoint, and this mapping enables none/);
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
    // ...and the endpoint it was created on (e0 = the provider's primary), so a
    // poll cannot land on a different endpoint of a multi-endpoint provider.
    expect(id).toMatch(new RegExp(`^video_abc-h${videoServiceId}x${providerId}e0t\\d+s[A-Za-z0-9_-]{43}$`));

    upstream.setHandler(jsonHandler(200, { id: "video_abc", status: "completed" }));
    const polled = await app.inject({ method: "GET", url: `/v1/videos/${id}`, headers: auth() });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().status).toBe("completed");
    expect(polled.json().id).toBe(id); // suffix re-applied so the client keeps using it
    expect(upstream.requests[1].url).toBe("/v1/videos/video_abc"); // suffix stripped upstream
  });

  it("rejects a stolen or tampered signed video capability", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(jsonHandler(200, { id: "video_secure", status: "queued" }));
    const created = await app.inject({ method: "POST", url: "/v1/videos", headers: auth(), payload: { model: "video-svc", prompt: "test" } });
    const id = created.json().id as string;
    const other = c.tokens.create({ name: "other", scopeServices: [videoServiceId] });
    const stolen = await app.inject({ url: `/v1/videos/${id}`, headers: { authorization: `Bearer ${other.secret}` } });
    expect(stolen.statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/videos/${id.replace(/e0t/, "e1t")}`, headers: auth() })).statusCode).toBe(404);
    expect(upstream.requests).toHaveLength(1);
  });
  it("polling an unsuffixed id is a clean 404", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/videos/video_raw", headers: auth() });
    expect(r.statusCode).toBe(404);
  });
});

const CRLF = "\r\n";
const IMAGE_BOUNDARY = "----hydrogenImageBoundary";
const IMAGE_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]),
  // A boundary-like byte sequence inside an image is NOT a form delimiter.
  Buffer.from(`pixels--${IMAGE_BOUNDARY}\r\nContent-Disposition: form-data; name="model"\r\n\r\nforged-service\r\n`),
  Buffer.from(`\r\n--${IMAGE_BOUNDARY}--not-a-delimiter\r\n--${IMAGE_BOUNDARY}-not-a-delimiter`),
]);
const SECOND_IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0x00, 0xfe, 0x80, 0xff, 0xd9]);
const MASK_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x80, 0xff]);

/** File parts deliberately precede the routing/override fields. Only the latter
 * may change; repeated image[] parts and the mask must stay byte-identical. */
function imageEditRequest(service: string, imageField = "image[]"): {
  method: "POST"; url: string; headers: Record<string, string>; payload: Buffer;
} {
  const filePart = (name: string, filename: string, type: string, bytes: Buffer) => Buffer.concat([
    Buffer.from(`--${IMAGE_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    bytes, Buffer.from(CRLF),
  ]);
  const textPart = (name: string, value: string) => Buffer.from(
    `--${IMAGE_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return {
    method: "POST", url: "/v1/images/edits",
    headers: { ...auth(), "content-type": `multipart/form-data; boundary="${IMAGE_BOUNDARY}"` },
    payload: Buffer.concat([
      filePart(imageField, "reference.png", "image/png", IMAGE_BYTES),
      ...(imageField === "image[]" ? [filePart(imageField, "style.jpg", "image/jpeg", SECOND_IMAGE_BYTES)] : []),
      filePart("mask", "mask.png", "image/png", MASK_BYTES),
      textPart("model", service),
      textPart("prompt", "add a blue hat using the reference style"),
      textPart("quality", "low"),
      Buffer.from(`--${IMAGE_BOUNDARY}--\r\n`),
    ]),
  };
}

describe("image edits and reference-image generation", () => {
  it.each(["image", "image[]"])("forwards %s uploads and masks with only the mapped model changed", async (field) => {
    upstream.requests.length = 0;
    const result = { created: 123, data: [{ b64_json: "edited-image", revised_prompt: "a blue hat" }] };
    upstream.setHandler(jsonHandler(200, result));
    const request = imageEditRequest("img", field);
    const original = Buffer.from(request.payload);
    const r = await app.inject(request);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(result);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].url).toBe("/v1/images/edits");
    expect(upstream.requests[0].headers.authorization).toBe("Bearer k");
    expect(upstream.requests[0].headers["content-type"]).toBe(request.headers["content-type"]);
    const modelField = Buffer.from(`name="model"${CRLF}${CRLF}img${CRLF}`);
    const at = original.indexOf(modelField);
    const expected = Buffer.concat([
      original.subarray(0, at),
      Buffer.from(`name="model"${CRLF}${CRLF}real-model${CRLF}`),
      original.subarray(at + modelField.length),
    ]);
    expect(upstream.requests[0].body).toEqual(expected);
    expect(request.payload).toEqual(original); // no in-place changes to the source form
  });

  it("passes JSON URL/data-URL references and masks through the edits endpoint", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(jsonHandler(200, { data: [{ url: "https://img.test/edited.png" }] }));
    const body = {
      model: "img-params", prompt: "combine these references", quality: "low",
      images: [
        { image_url: "https://images.test/reference.png" },
        { image_url: "data:image/png;base64,aW1hZ2U=" },
      ],
      mask: { image_url: "https://images.test/mask.png" },
      input_fidelity: "high",
    };
    const r = await app.inject({ method: "POST", url: "/v1/images/edits", headers: auth(), payload: body });
    expect(r.statusCode).toBe(200);
    expect(r.json().data[0].url).toBe("https://img.test/edited.png");
    expect(upstream.requests[0].url).toBe("/v1/images/edits");
    expect(JSON.parse(upstream.requests[0].body.toString())).toEqual({
      ...body, model: "real-model", quality: "high", n: 2, output_format: "webp",
    });
  });

  it("keeps provider-specific reference fields on generations rather than auto-switching endpoints", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(jsonHandler(200, { data: [{ url: "https://img.test/generated.png" }] }));
    const body = { model: "img", prompt: "use this style", image: ["https://images.test/style.png"], strength: 0.6 };
    const r = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth(), payload: body });
    expect(r.statusCode).toBe(200);
    expect(upstream.requests[0].url).toBe("/v1/images/generations");
    expect(JSON.parse(upstream.requests[0].body.toString())).toEqual({ ...body, model: "real-model" });
  });

  it("retries edits and applies multipart overrides without stacking fields or damaging files", async () => {
    upstream.requests.length = 0;
    let calls = 0;
    upstream.setHandler((_req, res) => {
      const status = ++calls === 1 ? 503 : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 503 ? { error: { message: "busy editing" } } : { data: [{ b64_json: "done" }] }));
    });
    const r = await app.inject(imageEditRequest("img-params"));
    expect(r.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[0].body).toEqual(upstream.requests[1].body);
    for (const sent of upstream.requests) {
      const text = sent.body.toString();
      expect(sent.url).toBe("/v1/images/edits");
      expect(text).toContain(`name="model"${CRLF}${CRLF}real-model`);
      expect(text).not.toContain("hijacked-model");
      expect(text).not.toContain(`name="quality"${CRLF}${CRLF}low`);
      for (const [key, value] of Object.entries({ quality: "high", n: "2", output_format: "webp" })) {
        expect(text.split(`name="${key}"`)).toHaveLength(2);
        expect(text).toContain(`name="${key}"${CRLF}${CRLF}${value}`);
      }
      for (const bytes of [IMAGE_BYTES, SECOND_IMAGE_BYTES, MASK_BYTES]) expect(sent.body.includes(bytes)).toBe(true);
      expect(text.endsWith(`--${IMAGE_BOUNDARY}--${CRLF}`)).toBe(true);
    }
  });

  it("rebuilds the original form with the next step's model and overrides on fallback", async () => {
    upstream.requests.length = 0;
    upstream.setHandler((req, res) => {
      const failed = req.body.includes(Buffer.from("real-model"));
      res.writeHead(failed ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(failed ? { error: { message: "unavailable" } } : { data: [{ b64_json: "fallback" }] }));
    });
    const r = await app.inject(imageEditRequest("img-fallback"));
    expect(r.statusCode).toBe(200);
    expect(r.json().data[0].b64_json).toBe("fallback");
    expect(upstream.requests).toHaveLength(2);
    const first = upstream.requests[0].body.toString();
    const second = upstream.requests[1].body.toString();
    expect(first).toContain(`name="quality"${CRLF}${CRLF}high`);
    expect(second).toContain(`name="quality"${CRLF}${CRLF}low`);
    expect(second).toContain(`name="model"${CRLF}${CRLF}fallback-model`);
    expect(second).not.toContain("real-model");
    expect(second).toContain(`name="size"${CRLF}${CRLF}1024x1024`);
    for (const sent of upstream.requests) {
      expect(sent.url).toBe("/v1/images/edits");
      for (const bytes of [IMAGE_BYTES, SECOND_IMAGE_BYTES, MASK_BYTES]) expect(sent.body.includes(bytes)).toBe(true);
    }
  });

  it("returns the upstream edit error after all retries", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(jsonHandler(503, { error: { message: "edit capacity exhausted" } }));
    const r = await app.inject(imageEditRequest("img"));
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toContain("edit capacity exhausted");
    expect(upstream.requests).toHaveLength(2);
  });

  it("requires authentication and enforces token service scope before sending image bytes", async () => {
    upstream.requests.length = 0;
    const request = imageEditRequest("img");
    const unauth = await app.inject({ ...request, headers: { "content-type": request.headers["content-type"] } });
    expect(unauth.statusCode).toBe(401);
    const limited = c.tokens.create({ name: "image-denied", scopeServices: [embServiceId] });
    const forbidden = await app.inject({ ...request, headers: { ...request.headers, authorization: `Bearer ${limited.secret}` } });
    expect(forbidden.statusCode).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects non-image services and forms without a text model field", async () => {
    upstream.requests.length = 0;
    const mismatch = await app.inject(imageEditRequest("emb"));
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.message).toContain("/v1/embeddings");
    const request = imageEditRequest("");
    const missing = await app.inject(request);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain("Missing 'model'");
    const noBoundary = await app.inject({ ...request, headers: { ...auth(), "content-type": "multipart/form-data" } });
    expect(noBoundary.statusCode).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it("logs multipart byte counts rather than reference images or masks", async () => {
    upstream.setHandler(jsonHandler(200, { data: [{ b64_json: "bulk-result" }] }));
    const r = await app.inject(imageEditRequest("img"));
    expect(r.statusCode).toBe(200);
    const row = c.logs.query({ limit: 1 }).rows[0];
    expect(row.serviceName).toBe("img");
    const log = c.logs.get(row.id);
    expect(log.requestPayload).toMatch(/multipart \d+ bytes/);
    expect(log.upstreamRequestPayload).toMatch(/multipart \d+ bytes/);
    expect(log.requestPayload).not.toContain("reference.png");
    expect(log.responsePayload).not.toContain("bulk-result");
  });
});

const STT_BOUNDARY = "----hydrogenTestBoundary";

/** One transcription upload: a `model` field, a `language` field the overrides
 * can collide with, and a file part nothing may touch. */
function sttRequest(service: string): { method: "POST"; url: string; headers: Record<string, string>; payload: string } {
  const payload = [
    `--${STT_BOUNDARY}`,
    'Content-Disposition: form-data; name="model"',
    "",
    service,
    `--${STT_BOUNDARY}`,
    'Content-Disposition: form-data; name="language"',
    "",
    "en-CLIENT",
    `--${STT_BOUNDARY}`,
    'Content-Disposition: form-data; name="file"; filename="a.wav"',
    "Content-Type: audio/wav",
    "",
    "RIFF-FAKE-AUDIO-DATA",
    `--${STT_BOUNDARY}--`,
    "",
  ].join(CRLF);
  return {
    method: "POST", url: "/v1/audio/transcriptions",
    headers: { ...auth(), "content-type": `multipart/form-data; boundary=${STT_BOUNDARY}` },
    payload,
  };
}

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
    const boundary = STT_BOUNDARY;
    const r = await app.inject(sttRequest("stt-svc"));
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

  it("stt logs the transcript, not a bare success marker", async () => {
    upstream.setHandler(jsonHandler(200, { text: "the quick brown fox" }));
    const r = await app.inject(sttRequest("stt-svc"));
    expect(r.statusCode).toBe(200);

    const row = c.logs.query({ limit: 1 }).rows[0];
    expect(row.serviceName).toBe("stt-svc");
    expect(JSON.parse(c.logs.get(row.id).responsePayload)).toEqual({ text: "the quick brown fox" });
  });

  it("stt sends the step's override parameters as multipart fields", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(jsonHandler(200, { text: "ok" }));
    const r = await app.inject(sttRequest("stt-params"));
    expect(r.statusCode).toBe(200);

    const forwarded = upstream.requests[0].body.toString();
    // `language` replaces the value the client sent; `temperature` and
    // `timestamp_granularities` are absent from the client form and get appended.
    expect(forwarded).toContain(`name="language"${CRLF}${CRLF}ja`);
    expect(forwarded).not.toContain("en-CLIENT");
    expect(forwarded).toContain(`name="temperature"${CRLF}${CRLF}0`);
    expect(forwarded).toContain(`name="timestamp_granularities"${CRLF}${CRLF}["word"]`);
    // The model rewrite still wins over an override that tried to set it.
    expect(forwarded).toContain(`name="model"${CRLF}${CRLF}real-model`);
    expect(forwarded).not.toContain("hijacked-model");
    expect(forwarded).toContain("RIFF-FAKE-AUDIO-DATA"); // file part still untouched
    // The closing delimiter stays last, so every appended part is inside the form.
    expect(forwarded.trimEnd().endsWith(`--${STT_BOUNDARY}--`)).toBe(true);
  });
});
