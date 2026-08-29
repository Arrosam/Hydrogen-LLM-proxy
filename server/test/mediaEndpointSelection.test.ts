/**
 * Media / ASR endpoint selection on a multi-endpoint provider.
 *
 * The OpenAI-shaped routes (embeddings, rerank, images, video, TTS, STT) do not
 * exist on an Anthropic endpoint. A provider whose PRIMARY is Anthropic can
 * still serve them through a declared OpenAI alternate, and these paths have to
 * pick that alternate rather than resolving to the primary and failing -- with
 * the URL, the auth header and the provider type all coming from the endpoint
 * that was actually chosen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { Catalog, MEDIA_FAMILIES } from "../src/catalog/catalog";
import { transcribeAudio } from "../src/execution/asr";
import type { ModelRepo } from "../src/persistence/modelRepo";
import type { ProviderRepo } from "../src/persistence/providerRepo";
import type { MappingRepo } from "../src/persistence/mappingRepo";

// --- unit: the selection itself ------------------------------------------

/** A provider whose primary endpoint is Anthropic, plus the alternates given. */
function catalogOf(opts: {
  primary?: string;
  families?: string[] | null;
  altEndpoints?: Array<{ type: string; baseUrl: string }> | null;
}) {
  const primary = opts.primary ?? "anthropic";
  const models = { getByName: () => ({ id: 1, name: "m", enabled: true }) } as unknown as ModelRepo;
  const providers = {
    getByName: () => ({
      id: 2, name: "p", enabled: true, type: primary, baseUrl: "http://p.test/anthropic",
      maxOutputTokens: null, altEndpoints: opts.altEndpoints ?? null,
    }),
    toUpstream: () => ({ type: primary, baseUrl: "http://p.test/anthropic", apiKey: "k", extraHeaders: null }),
  } as unknown as ProviderRepo;
  const mappings = {
    getPair: () => ({ id: 3, modelId: 1, providerId: 2, upstreamModel: "up", enabled: true, families: opts.families ?? null }),
  } as unknown as MappingRepo;
  return new Catalog(models, providers, mappings);
}

const RESPONSES_ALT = [{ type: "openai_responses", baseUrl: "http://p.test/openai/v1" }];

describe("constrained (media) endpoint resolution", () => {
  it("picks the enabled OpenAI alternate over an Anthropic primary", () => {
    const r = catalogOf({ altEndpoints: RESPONSES_ALT, families: ["anthropic", "openai_responses"] })
      .resolveWithin("m", "p", MEDIA_FAMILIES);
    expect(r.ok && r.target.family).toBe("openai_responses");
    // URL, auth and type all come from the chosen endpoint, not the primary.
    expect(r.ok && r.target.upstream.baseUrl).toBe("http://p.test/openai/v1");
    expect(r.ok && r.target.upstream.type).toBe("openai_responses");
    expect(r.ok && r.target.headers.authorization).toBe("Bearer k");
    expect(r.ok && r.target.headers["x-api-key"]).toBeUndefined();
    expect(r.ok && r.target.endpointIndex).toBe(1);
  });

  it("reports no usable endpoint when only Anthropic is enabled", () => {
    const r = catalogOf({ altEndpoints: RESPONSES_ALT, families: ["anthropic"] })
      .resolveWithin("m", "p", MEDIA_FAMILIES);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("no_endpoint_in_family");
  });

  it("reports no usable endpoint for an Anthropic-only provider", () => {
    const r = catalogOf({}).resolveWithin("m", "p", MEDIA_FAMILIES);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("no_endpoint_in_family");
  });

  it("never silently falls back to the Anthropic primary", () => {
    // families naming an endpoint the provider no longer has: plain resolve()
    // falls back to the primary by design, and that primary is Anthropic here.
    const plain = catalogOf({ families: ["openai_completion"] }).resolve("m", "p");
    expect(plain.ok && plain.target.family).toBe("anthropic");
    // The media path must not inherit that fallback.
    const r = catalogOf({ families: ["openai_completion"] }).resolveWithin("m", "p", MEDIA_FAMILIES);
    expect(r.ok).toBe(false);
  });

  it("still surfaces ordinary mapping errors unchanged", () => {
    const models = { getByName: () => undefined } as unknown as ModelRepo;
    const c = new Catalog(models, {} as ProviderRepo, {} as MappingRepo);
    const r = c.resolveWithin("nope", "p", MEDIA_FAMILIES);
    expect(!r.ok && r.error).toBe("model_not_found");
  });

  it("leaves plain chat resolution and its fallback untouched", () => {
    // Primary Anthropic, both families enabled: an Anthropic client still gets
    // the Anthropic endpoint, and a preference the mapping does not serve still
    // falls back to the primary rather than erroring.
    const c = catalogOf({ altEndpoints: RESPONSES_ALT, families: ["anthropic", "openai_responses"] });
    expect(c.resolve("m", "p", "anthropic").ok && c.resolve("m", "p", "anthropic").target.family).toBe("anthropic");
    expect(c.resolve("m", "p", "openai_responses").ok && c.resolve("m", "p", "openai_responses").target.family).toBe("openai_responses");
    expect(c.resolve("m", "p", "openai_completion").ok && c.resolve("m", "p", "openai_completion").target.family).toBe("anthropic");
    expect(c.resolve("m", "p").ok && c.resolve("m", "p").target.family).toBe("anthropic");
  });
});

describe("ASR pre-pass endpoint selection", () => {
  it("transcribes through the OpenAI alternate of an Anthropic-primary provider", async () => {
    const catalog = catalogOf({ altEndpoints: RESPONSES_ALT, families: ["anthropic", "openai_responses"] });
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const transport = {
      postJson: async () => { throw new Error("unused"); },
      postStream: async () => { throw new Error("unused"); },
      postRaw: async (url: string, headers: Record<string, string>) => {
        seen.push({ url, auth: headers.authorization });
        return { status: 200, headers: {}, json: { text: "hola" }, text: '{"text":"hola"}' };
      },
    } as unknown as Parameters<typeof transcribeAudio>[2]["transport"];

    const out = await transcribeAudio(
      { timeoutMs: 10_000, steps: [{ model: "m", provider: "p" }] },
      { data: Buffer.from("RIFF").toString("base64"), format: "wav" },
      { catalog, transport },
    );
    expect(out.result.ok).toBe(true);
    expect((out.result as { value: string }).value).toBe("hola");
    expect(seen[0].url).toBe("http://p.test/openai/v1/audio/transcriptions");
    expect(seen[0].auth).toBe("Bearer k");
  });
});

// --- integration: the media endpoints end to end -------------------------

interface CapturedRequest { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
type UpstreamHandler = (req: CapturedRequest, res: http.ServerResponse) => void;

function startUpstream(): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
  setHandler: (h: UpstreamHandler) => void;
  close: () => Promise<void>;
}> {
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
        baseUrl: `http://127.0.0.1:${port}/openai/v1`,
        requests,
        setHandler: (h) => { handler = h; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const json = (status: number, body: unknown): UpstreamHandler => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

let app: FastifyInstance;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let dataDir: string;
let secret: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let c: any;
let dualProviderId = 0;
let videoServiceId = 0;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-media-alt-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "media-alt-password";
  process.env.SESSION_SECRET = "media-alt-session-secret";

  upstream = await startUpstream();

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  c = await boot();

  // Primary Anthropic (a dead port -- reaching it at all is the bug), with the
  // real server declared as an OpenAI Responses alternate.
  const dual = c.providers.create({
    name: "dual",
    type: "anthropic",
    baseUrl: "http://127.0.0.1:9/anthropic",
    apiKey: "k",
    altEndpoints: [{ type: "openai_responses", baseUrl: upstream.baseUrl }],
  });
  dualProviderId = dual.id;
  const anthroOnly = c.providers.create({ name: "anthro-only", type: "anthropic", baseUrl: "http://127.0.0.1:9/anthropic", apiKey: "k" });

  const model = c.models.create({ name: "m1" });
  c.mappings.create({
    modelId: model.id, providerId: dual.id, upstreamModel: "real-model",
    families: ["anthropic", "openai_responses"],
  });
  c.mappings.create({ modelId: model.id, providerId: anthroOnly.id, upstreamModel: "claude-x" });

  const mk = (name: string, definition: unknown): { id: number } => c.services.create({ name, definition });
  mk("emb-alt", { category: "embedding", timeoutMs: 10_000, steps: [{ model: "m1", provider: "dual" }] });
  mk("img-alt", { category: "image", timeoutMs: 10_000, steps: [{ model: "m1", provider: "dual" }] });
  mk("stt-alt", { category: "stt", timeoutMs: 10_000, steps: [{ model: "m1", provider: "dual" }] });
  videoServiceId = mk("video-alt", { category: "video", timeoutMs: 10_000, steps: [{ model: "m1", provider: "dual" }] }).id;

  secret = c.tokens.create({ name: "t" }).secret;
  app = await buildApp(c);
});

afterAll(async () => {
  await app.close();
  await upstream.close();
  c.sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const auth = (): Record<string, string> => ({ authorization: `Bearer ${secret}` });

describe("media services on an Anthropic-primary provider", () => {
  it("saves a media service when an OpenAI alternate is enabled", () => {
    const { summary } = c.validator.validate({
      category: "embedding", timeoutMs: 10_000, steps: [{ model: "m1", provider: "dual" }],
    });
    expect(summary).toContain("[embedding]");
  });

  it("still rejects a media service with no OpenAI endpoint at all", () => {
    expect(() =>
      c.validator.validate({ category: "embedding", timeoutMs: 10_000, steps: [{ model: "m1", provider: "anthro-only" }] }),
    ).toThrowError(/require an OpenAI-compatible endpoint, and this mapping enables none/);
  });

  it("rejects inline ASR steps with no OpenAI endpoint", () => {
    expect(() =>
      c.validator.validate({
        kind: "micro_agent", timeoutMs: 10_000,
        stages: [{ name: "s1", steps: [{ model: "m1", provider: "dual" }], input: [] }],
        asr: { steps: [{ model: "m1", provider: "anthro-only" }] },
      }),
    ).toThrowError(/audio transcription \(ASR\) steps require an OpenAI-compatible endpoint/);
  });

  it("embeddings reach the alternate endpoint, not the Anthropic primary", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(json(200, { data: [{ embedding: [0.1] }], usage: { prompt_tokens: 3, total_tokens: 3 } }));
    const r = await app.inject({ method: "POST", url: "/v1/embeddings", headers: auth(), payload: { model: "emb-alt", input: "hi" } });
    expect(r.statusCode).toBe(200);
    expect(upstream.requests[0].url).toBe("/openai/v1/embeddings");
    expect(upstream.requests[0].headers.authorization).toBe("Bearer k");
    // Never the Anthropic auth scheme, which is what the primary would have used.
    expect(upstream.requests[0].headers["x-api-key"]).toBeUndefined();
  });

  it("image generation reaches the alternate endpoint", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(json(200, { data: [{ url: "http://img" }] }));
    const r = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth(), payload: { model: "img-alt", prompt: "a cat" } });
    expect(r.statusCode).toBe(200);
    expect(upstream.requests[0].url).toBe("/openai/v1/images/generations");
  });

  it("transcription (STT) reaches the alternate endpoint", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(json(200, { text: "hello there" }));
    const boundary = "----hydrogen-test";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nstt-alt\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\nRIFFDATA\r\n--${boundary}--\r\n`,
      "utf8",
    );
    const r = await app.inject({
      method: "POST", url: "/v1/audio/transcriptions",
      headers: { ...auth(), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().text).toBe("hello there");
    expect(upstream.requests[0].url).toBe("/openai/v1/audio/transcriptions");
    expect(upstream.requests[0].body.toString()).toContain("real-model"); // model field rewritten
  });

  it("video create, poll and download all stay on the endpoint that created the job", async () => {
    upstream.requests.length = 0;
    upstream.setHandler(json(200, { id: "vid_1", status: "queued" }));
    const created = await app.inject({ method: "POST", url: "/v1/videos", headers: auth(), payload: { model: "video-alt", prompt: "a dog" } });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    // The alternate is endpoint index 1; the id has to say so, or the poll below
    // would be sent to the provider's Anthropic primary.
    expect(id).toBe(`vid_1-h${videoServiceId}x${dualProviderId}e1`);
    expect(upstream.requests[0].url).toBe("/openai/v1/videos");

    upstream.setHandler(json(200, { id: "vid_1", status: "completed" }));
    const polled = await app.inject({ method: "GET", url: `/v1/videos/${id}`, headers: auth() });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().id).toBe(id);
    expect(upstream.requests[1].url).toBe("/openai/v1/videos/vid_1");
    expect(upstream.requests[1].headers.authorization).toBe("Bearer k");

    upstream.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.from("MP4BYTES"));
    });
    const content = await app.inject({ method: "GET", url: `/v1/videos/${id}/content`, headers: auth() });
    expect(content.statusCode).toBe(200);
    expect(upstream.requests[2].url).toBe("/openai/v1/videos/vid_1/content");
  });

  it("a job id naming an endpoint the provider no longer has is a clean error", async () => {
    const r = await app.inject({
      method: "GET", url: `/v1/videos/vid_1-h${videoServiceId}x${dualProviderId}e7`, headers: auth(),
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toContain("endpoint that created this video no longer exists");
  });

  it("an id from before endpoint routing still resolves to the primary", async () => {
    // Old ids carried no endpoint group; they can only have come from index 0.
    // Here that is the Anthropic primary, so the request is refused rather than
    // posted at an Anthropic base URL.
    const r = await app.inject({
      method: "GET", url: `/v1/videos/vid_1-h${videoServiceId}x${dualProviderId}`, headers: auth(),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("no longer OpenAI-compatible");
  });
});
