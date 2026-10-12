/**
 * Independent verification (spec section TRANS): T9, T10, T11.
 *
 * Written from the verification spec only. The app is booted whole and driven
 * through Fastify's inject; upstreams are loopback servers that record every
 * request they receive, so "no upstream request" is observed, not inferred.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

interface Recorder {
  baseUrl: string;
  urls: string[];
  close: () => Promise<void>;
}

/** A loopback upstream answering every media shape with a 200, recording the paths asked for. */
function startRecorder(): Promise<Recorder> {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      const url = req.url ?? "";
      urls.push(url);
      if (url.endsWith("/content")) {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(Buffer.from("FAKE-MP4"));
        return;
      }
      if (url.includes("/audio/speech")) {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.end(Buffer.from("FAKE-MP3"));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (url.includes("/videos")) res.end(JSON.stringify({ id: "job1", status: "completed" }));
      else if (url.includes("/embeddings")) res.end(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1] }], model: "up", usage: { prompt_tokens: 1, total_tokens: 1 } }));
      else res.end(JSON.stringify({ ok: true, data: [], results: [] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, urls, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let h: AdminHarness;
let upA: Recorder, upB: Recorder, upC: Recorder;
const providers: Record<"a" | "b" | "c", number> = { a: 0, b: 0, c: 0 };
const ids: Record<string, number> = {};
let unscopedKey = "";

const stepA = { model: "m", provider: "prov-a" };
const stepB = { model: "m", provider: "prov-b" };
const one = (category?: string, step = stepA) => ({ timeoutMs: 30_000, steps: [step], ...(category ? { category } : {}) });

beforeAll(async () => {
  [upA, upB, upC] = await Promise.all([startRecorder(), startRecorder(), startRecorder()]);
  h = await startAdminHarness("verify-trans-media", { ALLOW_PRIVATE_UPSTREAMS: "1", LOG_PAYLOAD_MAX_CHARS: "0" });
  const c = h.c;
  providers.a = c.providers.create({ name: "prov-a", type: "openai_completion", baseUrl: upA.baseUrl, apiKey: "k" }).id;
  providers.b = c.providers.create({ name: "prov-b", type: "openai_completion", baseUrl: upB.baseUrl, apiKey: "k" }).id;
  providers.c = c.providers.create({ name: "prov-c", type: "openai_completion", baseUrl: upC.baseUrl, apiKey: "k" }).id;
  const model = c.models.create({ name: "m" });
  // Every provider can serve the model; what differs is which a SERVICE's steps use.
  for (const providerId of Object.values(providers)) c.mappings.create({ modelId: model.id, providerId, upstreamModel: "up" });

  const add = (name: string, definition: unknown, enabled = true): void => {
    ids[name] = c.services.create({ name, definition: definition as never, enabled }).id;
  };
  add("chat-svc", one());
  add("chat-other", one());
  add("chat-off", one(), false);
  add("embedder", one("embedding"));
  add("embedder-off", one("embedding"), false);
  add("painter", one("image"));
  add("painter-off", one("image"), false);
  add("ranker", one("rerank"));
  add("ranker-off", one("rerank"), false);
  add("speaker", one("tts"));
  add("speaker-off", one("tts"), false);
  add("filmer", one("video"));
  add("filmer-off", one("video"), false);
  add("filmer-two", { timeoutMs: 30_000, category: "video", steps: [stepA, stepB] });
  add("agent", { kind: "micro_agent", timeoutMs: 30_000, stages: [{ name: "only", input: [], steps: [stepA] }] });
  add("broken-embedding", { category: "embedding", steps: "not-a-list" });
  add("broken-image", { category: "image", steps: "not-a-list" });
  add("broken-rerank", { category: "rerank", steps: "not-a-list" });
  add("broken-tts", { category: "tts", steps: "not-a-list" });
  add("broken-video", { category: "video", steps: "not-a-list" });

  unscopedKey = c.tokens.create({ name: "unscoped" }).secret;
}, 30_000);

afterAll(async () => {
  await h.close();
  await Promise.all([upA.close(), upB.close(), upC.close()]);
});

const sql = <T>(text: string, ...args: unknown[]): T =>
  (h.c.sqlite as never as { prepare(s: string): { get(...a: unknown[]): unknown } }).prepare(text).get(...args) as T;
const logCount = (): number => sql<{ n: number }>("SELECT COUNT(*) AS n FROM request_logs").n;
const lastStatus = (): number => sql<{ http_status: number }>("SELECT http_status FROM request_logs ORDER BY id DESC LIMIT 1").http_status;
const used = (tokenId: number): number => sql<{ n: number }>("SELECT used_requests AS n FROM tokens WHERE id = ?", tokenId).n;
const upstreamCalls = (): number => upA.urls.length + upB.urls.length + upC.urls.length;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

let keySeq = 0;
function mintKey(input: Record<string, unknown> = {}): { id: number; secret: string; headers: Record<string, string> } {
  const made = h.c.tokens.create({ name: `key-${keySeq++}`, ...input } as never);
  return { id: made.token.id, secret: made.secret, headers: { authorization: `Bearer ${made.secret}` } };
}

// ---------------------------------------------------------------------------
// T9 — a video id may only name a provider the service's steps use
// ---------------------------------------------------------------------------

describe("T9: video status/content with a client-supplied provider id", () => {
  const videoId = (service: string, providerId: number): string => `job1-h${ids[service]}x${providerId}e0`;
  const auth = () => ({ authorization: `Bearer ${unscopedKey}` });
  const poll = (id: string, suffix = "") => h.app.inject({ method: "GET", url: `/v1/videos/${id}${suffix}`, headers: auth() });

  for (const suffix of ["", "/content"]) {
    const label = suffix === "" ? "status" : "content";

    it(`${label}: a provider the service's steps do not use → 404 and no upstream request`, async () => {
      for (const foreign of [providers.b, providers.c]) {
        const before = upstreamCalls();
        const res = await poll(videoId("filmer", foreign), suffix);
        await settle();
        expect(res.statusCode, `provider ${foreign}`).toBe(404);
        expect(upstreamCalls() - before, `provider ${foreign}`).toBe(0);
      }
    });

    it(`${label}: the provider the service uses still works and is the one polled`, async () => {
      const beforeA = upA.urls.length;
      const beforeOthers = upB.urls.length + upC.urls.length;
      const res = await poll(videoId("filmer", providers.a), suffix);
      expect(res.statusCode).toBe(200);
      expect(upA.urls.length - beforeA).toBe(1);
      expect(upA.urls.at(-1)).toBe(`/v1/videos/job1${suffix}`);
      expect(upB.urls.length + upC.urls.length).toBe(beforeOthers);
    });

    it(`${label}: every provider of a multi-step service is allowed, a third one is not`, async () => {
      const beforeB = upB.urls.length;
      const second = await poll(videoId("filmer-two", providers.b), suffix);
      expect(second.statusCode).toBe(200);
      expect(upB.urls.length - beforeB).toBe(1);

      const beforeA = upA.urls.length;
      const first = await poll(videoId("filmer-two", providers.a), suffix);
      expect(first.statusCode).toBe(200);
      expect(upA.urls.length - beforeA).toBe(1);

      const before = upstreamCalls();
      const third = await poll(videoId("filmer-two", providers.c), suffix);
      await settle();
      expect(third.statusCode).toBe(404);
      expect(upstreamCalls() - before).toBe(0);
    });
  }

  it("status: the answer for the allowed provider carries the job's state", async () => {
    const res = await poll(videoId("filmer", providers.a));
    expect((res.json() as { status: string }).status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// T10 — GET /v1/models honours the key's service scope
// ---------------------------------------------------------------------------

describe("T10: GET /v1/models and the key's service scope", () => {
  const ENABLED = [
    "chat-svc", "chat-other", "embedder", "painter", "ranker", "speaker", "filmer", "filmer-two", "agent",
    "broken-embedding", "broken-image", "broken-rerank", "broken-tts", "broken-video",
  ];
  const DISABLED = ["chat-off", "embedder-off", "painter-off", "ranker-off", "speaker-off", "filmer-off"];

  const openaiList = async (secret: string): Promise<string[]> => {
    const res = await h.app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${secret}` } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { data: Array<{ id: string }> }).data.map((m) => m.id);
  };
  const anthropicList = async (secret: string): Promise<{ ids: string[]; first: string | null; last: string | null }> => {
    const res = await h.app.inject({ method: "GET", url: "/v1/models", headers: { "x-api-key": secret, "anthropic-version": "2023-06-01" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }>; first_id: string | null; last_id: string | null };
    return { ids: body.data.map((m) => m.id), first: body.first_id, last: body.last_id };
  };

  it("an unscoped key lists every enabled service and no disabled one", async () => {
    const listed = await openaiList(unscopedKey);
    expect([...listed].sort()).toEqual([...ENABLED].sort());
    for (const name of DISABLED) expect(listed).not.toContain(name);
  });

  it("a key scoped to one service lists exactly that service", async () => {
    const key = mintKey({ scopeServices: [ids["chat-other"]] });
    expect(await openaiList(key.secret)).toEqual(["chat-other"]);
  });

  it("a key scoped to several services (chat and media) lists exactly those", async () => {
    const key = mintKey({ scopeServices: [ids.embedder, ids["chat-svc"], ids.filmer] });
    expect((await openaiList(key.secret)).sort()).toEqual(["chat-svc", "embedder", "filmer"]);
  });

  it("the Anthropic form of the listing is scoped the same way, cursors included", async () => {
    const key = mintKey({ scopeServices: [ids.painter] });
    expect(await anthropicList(key.secret)).toEqual({ ids: ["painter"], first: "painter", last: "painter" });
    expect([...(await anthropicList(unscopedKey)).ids].sort()).toEqual([...ENABLED].sort());
  });

  it("a scoped key does not see a disabled service even when it is in scope", async () => {
    const key = mintKey({ scopeServices: [ids["chat-svc"], ids["chat-off"]] });
    expect(await openaiList(key.secret)).toEqual(["chat-svc"]);
  });

  it("listing does not change what an unscoped key sees afterwards", async () => {
    mintKey({ scopeServices: [ids.ranker] });
    expect([...(await openaiList(unscopedKey))].sort()).toEqual([...ENABLED].sort());
  });
});

// ---------------------------------------------------------------------------
// T11 — a refused media request writes exactly one log row and spends no quota
// ---------------------------------------------------------------------------

interface Endpoint {
  url: string;
  category: string;
  /** Service names of this endpoint's own category. */
  own: string;
  disabled: string;
  broken: string;
  /** An enabled service of a DIFFERENT media category. */
  otherMedia: string;
  body: Record<string, unknown>;
}

const ENDPOINTS: Endpoint[] = [
  { url: "/v1/embeddings", category: "embedding", own: "embedder", disabled: "embedder-off", broken: "broken-embedding", otherMedia: "painter", body: { input: "hi" } },
  { url: "/v1/images/generations", category: "image", own: "painter", disabled: "painter-off", broken: "broken-image", otherMedia: "embedder", body: { prompt: "a dog" } },
  { url: "/v1/rerank", category: "rerank", own: "ranker", disabled: "ranker-off", broken: "broken-rerank", otherMedia: "embedder", body: { query: "q", documents: ["a"] } },
  { url: "/v1/audio/speech", category: "tts", own: "speaker", disabled: "speaker-off", broken: "broken-tts", otherMedia: "embedder", body: { input: "hi", voice: "alloy" } },
  { url: "/v1/videos", category: "video", own: "filmer", disabled: "filmer-off", broken: "broken-video", otherMedia: "embedder", body: { prompt: "a dog" } },
];

describe("T11: refused media requests — one log row with the refusal's status, no quota", () => {
  /** One call with a fresh key; reports the status and everything it left behind. */
  async function observe(url: string, body: Record<string, unknown>): Promise<{ status: number; rows: number; rowStatus: number | null; quota: number; upstream: number }> {
    const key = mintKey();
    const before = { logs: logCount(), upstream: upstreamCalls() };
    const res = await h.app.inject({ method: "POST", url, headers: key.headers, payload: body });
    await settle();
    const rows = logCount() - before.logs;
    return { status: res.statusCode, rows, rowStatus: rows > 0 ? lastStatus() : null, quota: used(key.id), upstream: upstreamCalls() - before.upstream };
  }

  for (const ep of ENDPOINTS) {
    describe(`${ep.url}`, () => {
      const refusals: Array<[string, () => string, number]> = [
        ["an unknown service", () => "no-such-service", 404],
        ["a disabled service of the right category", () => ep.disabled, 404],
        ["a chat service (wrong category)", () => "chat-svc", 400],
        ["a service of another media category", () => ep.otherMedia, 400],
        ["a Micro Agent", () => "agent", 400],
        ["a service whose stored definition does not parse", () => ep.broken, 500],
      ];

      for (const [label, model, status] of refusals) {
        it(`${label} → ${status}, exactly one row with ${status}, no quota, nothing upstream`, async () => {
          const got = await observe(ep.url, { model: model(), ...ep.body });
          expect(got).toEqual({ status, rows: 1, rowStatus: status, quota: 0, upstream: 0 });
        });
      }

      it("unchanged: a served request writes one 200 row, spends one request of quota and goes upstream once", async () => {
        const got = await observe(ep.url, { model: ep.own, ...ep.body });
        expect(got).toEqual({ status: 200, rows: 1, rowStatus: 200, quota: 1, upstream: 1 });
      });
    });
  }

  describe("/v1/audio/transcriptions (multipart)", () => {
    const BOUNDARY = "----verifyTransBoundary";
    const CRLF = "\r\n";
    async function transcribe(service: string): Promise<{ status: number; rows: number; rowStatus: number | null; quota: number; upstream: number }> {
      const key = mintKey();
      const payload = [
        `--${BOUNDARY}`, 'Content-Disposition: form-data; name="model"', "", service,
        `--${BOUNDARY}`, 'Content-Disposition: form-data; name="file"; filename="a.wav"', "Content-Type: audio/wav", "", "RIFF-FAKE",
        `--${BOUNDARY}--`, "",
      ].join(CRLF);
      const before = { logs: logCount(), upstream: upstreamCalls() };
      const res = await h.app.inject({
        method: "POST", url: "/v1/audio/transcriptions",
        headers: { ...key.headers, "content-type": `multipart/form-data; boundary=${BOUNDARY}` }, payload,
      });
      await settle();
      const rows = logCount() - before.logs;
      return { status: res.statusCode, rows, rowStatus: rows > 0 ? lastStatus() : null, quota: used(key.id), upstream: upstreamCalls() - before.upstream };
    }

    it.each([
      ["an unknown service", "no-such-service", 404],
      ["a chat service (wrong category)", "chat-svc", 400],
      ["a service of another media category", "embedder", 400],
      ["a Micro Agent", "agent", 400],
    ] as Array<[string, string, number]>)("%s → one row with the refusal's status, no quota", async (_label, service, status) => {
      expect(await transcribe(service)).toEqual({ status, rows: 1, rowStatus: status, quota: 0, upstream: 0 });
    });
  });
});
