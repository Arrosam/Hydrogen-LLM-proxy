/**
 * Media surface and model listing fixes.
 * T9  — a video poll/download only reaches a provider the id's own service
 *       routes video to; any other (service, provider) pairing is a 404.
 * T10 — GET /v1/models lists only the services the API key may call.
 * T11 — a media request refused after its service was named leaves a
 *       request-log row, as the chat endpoints do (no quota is spent).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;
let upstream: FakeUpstream;
let elsewhere: FakeUpstream;
const ids: Record<string, number> = {};
let providerId = 0;
let otherProviderId = 0;
let anyKey = "";
let scopedKey = "";
let anyTokenId = 0;

const STEP = { model: "m", provider: "fake" };
const STEPS = { timeoutMs: 30_000, steps: [STEP] };

beforeAll(async () => {
  upstream = await startFakeUpstream({ text: "pong" });
  elsewhere = await startFakeUpstream({ text: "pong" });
  h = await startAdminHarness("fix-trans-media", { ALLOW_PRIVATE_UPSTREAMS: "1" });
  const c = h.c;
  providerId = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" }).id;
  otherProviderId = c.providers.create({ name: "elsewhere", type: "openai_completion", baseUrl: elsewhere.baseUrl, apiKey: "secret-of-another-provider" }).id;
  const model = c.models.create({ name: "m" });
  c.mappings.create({ modelId: model.id, providerId, upstreamModel: "up" });
  const add = (name: string, definition: unknown, enabled = true): void => {
    ids[name] = c.services.create({ name, definition: definition as never, enabled }).id;
  };
  add("svc", STEPS);
  add("other", STEPS);
  add("off", STEPS, false);
  add("embedder", { ...STEPS, category: "embedding" });
  add("filmer", { ...STEPS, category: "video" });
  add("agent", { kind: "micro_agent", timeoutMs: 30_000, stages: [{ name: "only", input: [], steps: [STEP] }] });
  add("broken", { steps: [] });
  const any = c.tokens.create({ name: "any" });
  anyKey = any.secret;
  anyTokenId = any.token.id;
  scopedKey = c.tokens.create({ name: "scoped", scopeServices: [ids.other, ids.filmer] }).secret;
}, 30_000);

afterAll(async () => {
  await h.close();
  await upstream.close();
  await elsewhere.close();
});

interface LogRow { http_status: number; error: string | null; service_id: number | null; requested_service: string | null; request_path: string; attempts: number }
const sql = <T>(text: string, ...args: unknown[]): T => (h.c.sqlite as never as { prepare(s: string): { get(...a: unknown[]): unknown } }).prepare(text).get(...args) as T;
const logCount = (): number => sql<{ n: number }>("SELECT COUNT(*) AS n FROM request_logs").n;
const lastRow = (): LogRow => sql<LogRow>("SELECT http_status, error, service_id, requested_service, request_path, attempts FROM request_logs ORDER BY id DESC LIMIT 1");
const used = (): number => sql<{ n: number }>("SELECT used_requests AS n FROM tokens WHERE id = ?", anyTokenId).n;
const bearer = (key = anyKey) => ({ authorization: `Bearer ${key}` });

describe("T9: a video id cannot address a provider its service does not route video to", () => {
  const poll = async (service: number, provider: number, content = false, key = anyKey) => {
    const before = { here: upstream.requests, there: elsewhere.requests };
    const res = await h.app.inject({ method: "GET", url: `/v1/videos/job1-h${service}x${provider}e0${content ? "/content" : ""}`, headers: bearer(key) });
    return { status: res.statusCode, body: res.body, here: upstream.requests - before.here, there: elsewhere.requests - before.there };
  };

  it("the service's own provider is still polled", async () => {
    expect(await poll(ids.filmer, providerId)).toMatchObject({ here: 1, there: 0 });
    expect(await poll(ids.filmer, providerId, true)).toMatchObject({ here: 1, there: 0 });
  });

  for (const content of [false, true]) {
    it(`another enabled provider is a 404 and is never contacted (${content ? "download" : "poll"})`, async () => {
      const got = await poll(ids.filmer, otherProviderId, content);
      expect(got).toMatchObject({ status: 404, here: 0, there: 0 });
      expect(JSON.parse(got.body).error.message).toBe("The service that created this video no longer routes video to that provider.");
    });
  }

  it("a service that is not a video Model Service cannot be used to reach any provider", async () => {
    for (const name of ["svc", "embedder", "agent", "broken"]) {
      expect(await poll(ids[name], providerId), name).toMatchObject({ status: 404, here: 0, there: 0 });
      expect(await poll(ids[name], otherProviderId), name).toMatchObject({ status: 404, here: 0, there: 0 });
    }
  });

  it("a key scoped to the video service is bound by the same rule", async () => {
    expect(await poll(ids.filmer, otherProviderId, false, scopedKey)).toMatchObject({ status: 404, here: 0, there: 0 });
    expect(await poll(ids.filmer, providerId, false, scopedKey)).toMatchObject({ here: 1 });
  });
});

describe("T10: GET /v1/models honours the key's service scope", () => {
  const enabled = ["svc", "other", "embedder", "filmer", "agent", "broken"];
  const names = async (key: string, anthropic = false): Promise<string[]> => {
    const res = await h.app.inject({ url: "/v1/models", headers: anthropic ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : bearer(key) });
    expect(res.statusCode).toBe(200);
    return (res.json().data as Array<{ id: string }>).map((m) => m.id).sort();
  };

  it("an unscoped key sees every enabled service", async () => {
    expect(await names(anyKey)).toEqual([...enabled].sort());
    expect(await names(anyKey, true)).toEqual([...enabled].sort());
  });

  it("a scoped key sees only its services, on both wire shapes", async () => {
    expect(await names(scopedKey)).toEqual(["filmer", "other"]);
    expect(await names(scopedKey, true)).toEqual(["filmer", "other"]);
    const res = await h.app.inject({ url: "/v1/models", headers: { "x-api-key": scopedKey, "anthropic-version": "2023-06-01" } });
    expect([res.json().first_id, res.json().last_id].sort()).toEqual(["filmer", "other"]);
  });
});

describe("T11: media refusals are logged like chat refusals", () => {
  const refused = async (url: string, model: string) => {
    const before = { logs: logCount(), used: used(), upstream: upstream.requests };
    const res = await h.app.inject({ method: "POST", url, headers: { ...bearer(), "content-type": "application/json" }, payload: JSON.stringify({ model, input: "hi" }) });
    const logged = logCount() - before.logs;
    return { status: res.statusCode, logged, row: logged ? lastRow() : null, quotaSpent: used() - before.used, upstreamCalls: upstream.requests - before.upstream };
  };

  it("unknown and disabled services: 404", async () => {
    for (const name of ["nope", "off"]) {
      expect(await refused("/v1/embeddings", name)).toEqual({
        status: 404, logged: 1, quotaSpent: 0, upstreamCalls: 0,
        row: { http_status: 404, error: `unknown model '${name}'`, service_id: null, requested_service: name, request_path: "/v1/embeddings", attempts: 0 },
      });
    }
  });

  it("a service of another category, and a Micro Agent: 400", async () => {
    expect(await refused("/v1/embeddings", "svc")).toEqual({
      status: 400, logged: 1, quotaSpent: 0, upstreamCalls: 0,
      row: { http_status: 400, error: "'svc' is a chat service", service_id: ids.svc, requested_service: "svc", request_path: "/v1/embeddings", attempts: 0 },
    });
    expect(await refused("/v1/audio/speech", "agent")).toEqual({
      status: 400, logged: 1, quotaSpent: 0, upstreamCalls: 0,
      row: { http_status: 400, error: "'agent' is a Micro Agent", service_id: ids.agent, requested_service: "agent", request_path: "/v1/audio/speech", attempts: 0 },
    });
  });

  it("an invalid stored definition: 500", async () => {
    const got = await refused("/v1/embeddings", "broken");
    expect(got).toMatchObject({ status: 500, logged: 1, quotaSpent: 0, upstreamCalls: 0, row: { http_status: 500, service_id: ids.broken, requested_service: "broken" } });
    expect(got.row!.error).toMatch(/^invalid Model Service definition: /);
  });

  it("a request that names no service leaves no row (as on chat)", async () => {
    const before = logCount();
    const res = await h.app.inject({ method: "POST", url: "/v1/embeddings", headers: { ...bearer(), "content-type": "application/json" }, payload: JSON.stringify({ input: "hi" }) });
    expect(res.statusCode).toBe(400);
    expect(logCount() - before).toBe(0);
  });
});
