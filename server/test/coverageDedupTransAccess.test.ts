/**
 * Characterization of "may this caller run this service here?" across every
 * surface that answers it: the chat endpoints, the stateful Responses path,
 * the media endpoints (create and video poll) and the admin bench.
 *
 * The surfaces deliberately disagree -- in wording, in status (an invalid
 * stored definition is a 500 on chat/media and a 400 on Responses and bench),
 * in which rejections write a request-log row, and in whether a rejection
 * spends one request of the key's quota. Each cell is pinned as observed:
 * status, body, the log row written (if any) and the quota spent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;
let upstream: FakeUpstream;
const ids: Record<string, number> = {};
let providerId = 0;
let anyKey = "";
let scopedKey = "";
let anyTokenId = 0;
let scopedTokenId = 0;

const STEP = { model: "m", provider: "fake" };
const STEPS = { timeoutMs: 30_000, steps: [STEP] };

beforeAll(async () => {
  upstream = await startFakeUpstream({ text: "pong" });
  h = await startAdminHarness("cov-dedup-access", { ALLOW_PRIVATE_UPSTREAMS: "1", LOG_PAYLOAD_MAX_CHARS: "0" });
  const c = h.c;
  providerId = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" }).id;
  const model = c.models.create({ name: "m" });
  c.mappings.create({ modelId: model.id, providerId, upstreamModel: "up" });

  const add = (name: string, definition: unknown, enabled = true): void => {
    ids[name] = c.services.create({ name, definition: definition as never, enabled }).id;
  };
  add("svc", STEPS);
  add("other", STEPS);
  add("off", STEPS, false);
  add("painter", { ...STEPS, category: "image" });
  add("embedder", { ...STEPS, category: "embedding" });
  add("filmer", { ...STEPS, category: "video" });
  add("filmer-off", { ...STEPS, category: "video" }, false);
  add("reader", { ...STEPS, category: "ocr" });
  add("agent", { kind: "micro_agent", timeoutMs: 30_000, stages: [{ name: "only", input: [], steps: [STEP] }] });
  add("broken", { steps: [] });

  const any = c.tokens.create({ name: "any" });
  const scoped = c.tokens.create({ name: "scoped", scopeServices: [ids.other] });
  anyKey = any.secret;
  scopedKey = scoped.secret;
  anyTokenId = any.token.id;
  scopedTokenId = scoped.token.id;
}, 30_000);

afterAll(async () => {
  await h.close();
  await upstream.close();
});

interface LogRow {
  trace_id: string;
  http_status: number;
  error: string | null;
  service_id: number | null;
  requested_service: string | null;
  ingress: string | null;
  streaming: number;
  attempts: number;
  request_path: string;
}

const sql = <T>(text: string, ...args: unknown[]): T => (h.c.sqlite as never as { prepare(s: string): { get(...a: unknown[]): unknown } }).prepare(text).get(...args) as T;
const logCount = (): number => sql<{ n: number }>("SELECT COUNT(*) AS n FROM request_logs").n;
const used = (tokenId: number): number => sql<{ n: number }>("SELECT used_requests AS n FROM tokens WHERE id = ?", tokenId).n;
const nameOf = (id: number | null): string | null => (id == null ? null : Object.keys(ids).find((k) => ids[k] === id) ?? `#${id}`);

/** One client call, with everything it left behind. */
async function observe(o: { method?: "GET" | "POST"; url: string; key?: string; body?: unknown; headers?: Record<string, string> }): Promise<unknown> {
  const scoped = o.key === scopedKey;
  const tokenId = scoped ? scopedTokenId : anyTokenId;
  const key = o.key ?? anyKey;
  const auth: Record<string, string> = o.url === "/v1/messages" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` };
  const before = { logs: logCount(), used: used(tokenId), upstream: upstream.requests };
  const res = await h.app.inject({
    method: o.method ?? "POST",
    url: o.url,
    headers: { ...(o.body === undefined ? {} : { "content-type": "application/json" }), ...auth, ...o.headers },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  // The Responses path writes its row from the job's `finally`, a tick later.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const logged = logCount() - before.logs;
  let row: unknown = null;
  if (logged) {
    const r = sql<LogRow>("SELECT trace_id, http_status, error, service_id, requested_service, ingress_format AS ingress, streaming, attempts, request_path FROM request_logs ORDER BY id DESC LIMIT 1");
    row = { ...r, trace_id: r.trace_id.replace(/[-_].*$/, ""), service_id: nameOf(r.service_id) };
  }
  let body: unknown = res.body;
  try { body = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, body, logged, row, quotaSpent: used(tokenId) - before.used, upstreamCalls: upstream.requests - before.upstream };
}

const chatBody = (model: string, extra: Record<string, unknown> = {}) => ({ model, stream: false, messages: [{ role: "user", content: "hi" }], ...extra });
const CASES = ["nope", "off", "other-scoped", "painter", "broken"] as const;
const keyFor = (name: string): { model: string; key?: string } => (name === "other-scoped" ? { model: "svc", key: scopedKey } : { model: name });

describe("chat completions", () => {
  for (const name of CASES) {
    it(`${name}`, async () => {
      const { model, key } = keyFor(name);
      expect(await observe({ url: "/v1/chat/completions", key, body: chatBody(model) })).toMatchSnapshot();
    });
  }
  it("a streaming request is rejected the same way, logged as streaming", async () => {
    expect(await observe({ url: "/v1/chat/completions", body: chatBody("nope", { stream: true }) })).toMatchSnapshot("unknown");
    expect(await observe({ url: "/v1/chat/completions", body: chatBody("broken", { stream: true }) })).toMatchSnapshot("broken");
  });
});

describe("anthropic messages", () => {
  for (const name of CASES) {
    it(`${name}`, async () => {
      const { model, key } = keyFor(name);
      expect(await observe({ url: "/v1/messages", key, body: { model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] } })).toMatchSnapshot();
    });
  }
});

describe("responses (stateful path)", () => {
  for (const name of CASES) {
    it(`${name}`, async () => {
      const { model, key } = keyFor(name);
      expect(await observe({ url: "/v1/responses", key, body: { model, input: "hi" } })).toMatchSnapshot();
    });
  }
  it("no model at all", async () => {
    expect(await observe({ url: "/v1/responses", body: { input: "hi" } })).toMatchSnapshot();
  });
});

describe("media create (embeddings)", () => {
  for (const name of [...CASES, "svc", "reader", "agent", "filmer"] as const) {
    it(`${name}`, async () => {
      const { model, key } = keyFor(name === "other-scoped" ? name : name);
      const target = name === "other-scoped" ? { model: "embedder", key: scopedKey } : { model, key };
      expect(await observe({ url: "/v1/embeddings", key: target.key, body: { model: target.model, input: "hi" } })).toMatchSnapshot();
    });
  }
  it("no model at all", async () => {
    expect(await observe({ url: "/v1/embeddings", body: { input: "hi" } })).toMatchSnapshot();
  });
  it("speech names its own category in the rejection", async () => {
    expect(await observe({ url: "/v1/audio/speech", body: { model: "agent", input: "hi" } })).toMatchSnapshot("agent");
    expect(await observe({ url: "/v1/audio/speech", body: { model: "embedder", input: "hi" } })).toMatchSnapshot("embedder");
  });
});

describe("video poll", () => {
  const poll = (service: string, key?: string, provider = providerId, endpoint = "e0") =>
    observe({ method: "GET", url: `/v1/videos/job1-h${ids[service] ?? 99999}x${provider}${endpoint}`, key });

  it("an id this proxy did not hand out", async () => {
    expect(await observe({ method: "GET", url: "/v1/videos/plain-id" })).toMatchSnapshot();
  });
  it("a service that is gone, or disabled", async () => {
    expect(await poll("ghost")).toMatchSnapshot("gone");
    expect(await poll("filmer-off")).toMatchSnapshot("disabled");
  });
  it("a key scoped elsewhere", async () => {
    expect(await poll("filmer", scopedKey)).toMatchSnapshot();
  });
  it("the scope check comes before the provider check", async () => {
    expect(await poll("filmer", scopedKey, 99999)).toMatchSnapshot("scoped + missing provider");
    expect(await poll("filmer", undefined, 99999)).toMatchSnapshot("missing provider");
  });
  it("a missing endpoint index", async () => {
    expect(await poll("filmer", undefined, providerId, "e7")).toMatchSnapshot();
  });
  it("a service whose definition no longer parses cannot vouch for a provider: 404, nothing polled", async () => {
    const res = (await poll("broken")) as { status: number; logged: number; upstreamCalls: number };
    expect({ status: res.status, logged: res.logged, reachedUpstream: res.upstreamCalls > 0 }).toEqual({ status: 404, logged: 0, reachedUpstream: false });
  });
});

describe("admin bench", () => {
  const bench = async (url: string, payload: unknown) => {
    const before = logCount();
    const res = await h.admin({ method: "POST", url, payload });
    return { status: res.statusCode, body: res.json() as unknown, logged: logCount() - before };
  };
  const chat = (serviceId: number) => bench("/bench/chat", { target: { kind: "service", serviceId }, ingress: "openai_completion", body: chatBody("x") });
  const media = (serviceId: number, category = "embedding") => bench("/bench/media", { target: { kind: "service", serviceId }, category, body: { input: "hi" } });

  it("chat: unknown id, invalid definition, media service", async () => {
    expect(await chat(99999)).toMatchSnapshot("unknown");
    expect(await chat(ids.broken)).toMatchSnapshot("broken");
    expect(await chat(ids.painter)).toMatchSnapshot("painter");
  });
  it("chat: a disabled service is benched all the same", async () => {
    const res = await chat(ids.off);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.logged).toBe(0);
  });
  it("media: unknown id, invalid definition, agent, other category", async () => {
    expect(await media(99999)).toMatchSnapshot("unknown");
    expect(await media(ids.broken)).toMatchSnapshot("broken");
    expect(await media(ids.agent)).toMatchSnapshot("agent");
    expect(await media(ids.painter)).toMatchSnapshot("painter");
    expect(await media(ids.svc, "chat")).toMatchSnapshot("chat category");
  });
});
