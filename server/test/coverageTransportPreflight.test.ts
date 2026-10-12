/**
 * What the chat endpoints answer BEFORE any upstream work starts, and the
 * model listing.
 *
 * Every case here is decided by the proxy alone: a request it cannot parse, a
 * model name it does not know, a key that may not use the service, a service
 * that is the wrong kind for the endpoint. The contract for each is the same
 * three things: the HTTP status, the error envelope in the CLIENT's wire
 * family, and whether a request-log row is written — plus that the upstream is
 * never contacted.
 *
 * Driven through the real app (auth, routing, repositories, sqlite) against a
 * real loopback upstream, so the "never contacted" claim is observed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";

interface LogRow {
  http_status: number;
  error: string | null;
  service_id: number | null;
  requested_service: string | null;
  ingress: string | null;
}

let app: FastifyInstance;
let upstream: FakeUpstream;
let dataDir = "";
let sqlite: { close: () => void; prepare: (s: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } };

/** Unrestricted key. */
let anyKey = "";
/** Key scoped to the service `other` only. */
let scopedKey = "";
/** Key whose scope list is present but empty (means: every service). */
let emptyScopeKey = "";
const ids: Record<string, number> = {};
/** Enable/disable a service by name (set once the container is up). */
let setEnabled: (name: string, enabled: boolean) => void = () => {};

const STEPS = { timeoutMs: 30_000, steps: [{ model: "m", provider: "fake" }] };

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-preflight-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "preflight-test-password";
  process.env.SESSION_SECRET = "preflight-test-session-secret";

  upstream = await startFakeUpstream({ text: "pong" });

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await boot();
  const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = c.models.create({ name: "m" });
  c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });

  ids.svc = c.services.create({ name: "svc", definition: STEPS as never }).id;
  ids.other = c.services.create({ name: "other", definition: STEPS as never }).id;
  ids.off = c.services.create({ name: "off", definition: STEPS as never, enabled: false }).id;
  ids.painter = c.services.create({ name: "painter", definition: { ...STEPS, category: "image" } as never }).id;
  // A row whose stored definition no longer parses (e.g. written by an older
  // version): the repository stores what it is given.
  ids.broken = c.services.create({ name: "broken", definition: { steps: [] } as never }).id;

  anyKey = c.tokens.create({ name: "any" }).secret;
  scopedKey = c.tokens.create({ name: "scoped", scopeServices: [ids.other] }).secret;
  emptyScopeKey = c.tokens.create({ name: "empty-scope", scopeServices: [] }).secret;
  sqlite = c.sqlite as never;
  setEnabled = (name, enabled) => { c.services.update(ids[name], { enabled }); };

  app = await buildApp(c);
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await upstream.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const logCount = (): number => (sqlite.prepare("SELECT COUNT(*) AS n FROM request_logs").get() as { n: number }).n;
const lastLog = (): LogRow =>
  sqlite.prepare("SELECT http_status, error, service_id, requested_service, ingress_format AS ingress FROM request_logs ORDER BY id DESC LIMIT 1").get() as LogRow;

interface Observed {
  status: number;
  body: Record<string, unknown>;
  /** Upstream attempts this call caused. */
  upstreamCalls: number;
  /** request_logs rows this call wrote. */
  logged: number;
}

async function call(o: {
  url?: string;
  key?: string;
  body: unknown;
  headers?: Record<string, string>;
}): Promise<Observed> {
  const url = o.url ?? "/v1/chat/completions";
  const key = o.key ?? anyKey;
  const auth: Record<string, string> = url === "/v1/messages"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${key}` };
  const before = { upstream: upstream.requests, logs: logCount() };
  const res = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...auth, ...o.headers },
    payload: typeof o.body === "string" ? o.body : JSON.stringify(o.body),
  });
  let body: Record<string, unknown> = {};
  try { body = res.json<Record<string, unknown>>(); } catch { /* not JSON */ }
  return { status: res.statusCode, body, upstreamCalls: upstream.requests - before.upstream, logged: logCount() - before.logs };
}

const chat = (model: string | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...(model === undefined ? {} : { model }),
  stream: false,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});
const anthropicChat = (model: string): Record<string, unknown> => ({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] });

const openaiError = (body: Record<string, unknown>): { message: string; type: string; code: unknown; param: unknown } =>
  body.error as { message: string; type: string; code: unknown; param: unknown };
const anthropicError = (body: Record<string, unknown>): { type: string; message: string } => {
  expect(body.type).toBe("error");
  return body.error as { type: string; message: string };
};

describe("DT: a key's service scope on the chat endpoints", () => {
  it("a key scoped to another service is refused with 403, logged, and the upstream is not contacted", async () => {
    const got = await call({ key: scopedKey, body: chat("svc") });

    expect(got.status).toBe(403);
    expect(openaiError(got.body)).toEqual({
      message: "This API key is not allowed to use 'svc'.", type: "authentication_error", code: null, param: null,
    });
    expect(got.upstreamCalls).toBe(0);
    expect(got.logged).toBe(1);
    expect(lastLog()).toEqual({
      http_status: 403, error: "service out of token scope", service_id: ids.svc, requested_service: "svc", ingress: "openai_completion",
    });
  });

  it("the same key may use the service it is scoped to", async () => {
    const got = await call({ key: scopedKey, body: chat("other") });
    expect(got.status).toBe(200);
    expect(got.upstreamCalls).toBe(1);
    expect(lastLog()).toMatchObject({ http_status: 200, error: null, service_id: ids.other });
  });

  it("on the Anthropic endpoint the refusal is a permission_error in Anthropic's envelope", async () => {
    const got = await call({ url: "/v1/messages", key: scopedKey, body: anthropicChat("svc") });
    expect(got.status).toBe(403);
    expect(anthropicError(got.body)).toEqual({ type: "permission_error", message: "This API key is not allowed to use 'svc'." });
    expect(got.upstreamCalls).toBe(0);
    expect(lastLog()).toMatchObject({ http_status: 403, error: "service out of token scope", ingress: "anthropic" });
  });

  it("the scope applies to streaming requests too, as a plain HTTP error (no SSE)", async () => {
    const got = await call({ key: scopedKey, body: chat("svc", { stream: true }) });
    expect(got.status).toBe(403);
    expect(openaiError(got.body).type).toBe("authentication_error");
    expect(got.upstreamCalls).toBe(0);
  });

  it("a key with no scope, or an empty scope list, may use any service", async () => {
    expect((await call({ key: anyKey, body: chat("svc") })).status).toBe(200);
    expect((await call({ key: emptyScopeKey, body: chat("svc") })).status).toBe(200);
    expect((await call({ key: emptyScopeKey, body: chat("other") })).status).toBe(200);
  });

  it("an unknown model is reported as not found even to a scoped key (existence is checked first)", async () => {
    const got = await call({ key: scopedKey, body: chat("ghost") });
    expect(got.status).toBe(404);
  });
});

describe("EP: the requested model must be a known, enabled service", () => {
  const NOT_FOUND = (name: string): string => `Model '${name}' not found. The 'model' field must be a Model Service or Micro Agent name.`;

  it("an unknown model is a 404, logged with no service id, and the upstream is not contacted", async () => {
    const got = await call({ body: chat("ghost") });

    expect(got.status).toBe(404);
    expect(openaiError(got.body)).toEqual({ message: NOT_FOUND("ghost"), type: "invalid_request_error", code: null, param: null });
    expect(got.upstreamCalls).toBe(0);
    expect(got.logged).toBe(1);
    expect(lastLog()).toEqual({
      http_status: 404, error: "unknown model 'ghost'", service_id: null, requested_service: "ghost", ingress: "openai_completion",
    });
  });

  it("a disabled service is indistinguishable from an unknown one", async () => {
    const got = await call({ body: chat("off") });

    expect(got.status).toBe(404);
    expect(openaiError(got.body)).toEqual({ message: NOT_FOUND("off"), type: "invalid_request_error", code: null, param: null });
    expect(got.upstreamCalls).toBe(0);
    expect(lastLog()).toEqual({
      http_status: 404, error: "unknown model 'off'", service_id: null, requested_service: "off", ingress: "openai_completion",
    });
  });

  it("on the Anthropic endpoint it is a not_found_error", async () => {
    const got = await call({ url: "/v1/messages", body: anthropicChat("ghost") });
    expect(got.status).toBe(404);
    expect(anthropicError(got.body)).toEqual({ type: "not_found_error", message: NOT_FOUND("ghost") });
    expect(lastLog()).toMatchObject({ http_status: 404, error: "unknown model 'ghost'", ingress: "anthropic" });
  });

  it("the upstream model name behind a service is not itself addressable", async () => {
    expect((await call({ body: chat("m") })).status).toBe(404);
    expect((await call({ body: chat("up") })).status).toBe(404);
  });

  it("service names are matched exactly", async () => {
    expect((await call({ body: chat("SVC") })).status).toBe(404);
    expect((await call({ body: chat("svc ") })).status).toBe(404);
  });
});

describe("EP: requests rejected before a service is even looked up", () => {
  it("a body with no model is a 400 and writes no log row", async () => {
    const got = await call({ body: chat(undefined) });

    expect(got.status).toBe(400);
    expect(openaiError(got.body)).toEqual({
      message: "Missing 'model' (must be a Model Service or Micro Agent name).", type: "invalid_request_error", code: null, param: null,
    });
    expect(got.upstreamCalls).toBe(0);
    expect(got.logged).toBe(0);
  });

  it("an empty model string counts as missing", async () => {
    const got = await call({ body: chat("") });
    expect(got.status).toBe(400);
    expect(openaiError(got.body).message).toContain("Missing 'model'");
    expect(got.logged).toBe(0);
  });

  it("on the Anthropic endpoint the same rejection uses Anthropic's envelope", async () => {
    const got = await call({ url: "/v1/messages", body: { max_tokens: 16, messages: [{ role: "user", content: "hi" }] } });
    expect(got.status).toBe(400);
    expect(anthropicError(got.body)).toEqual({ type: "invalid_request_error", message: "Missing 'model' (must be a Model Service or Micro Agent name)." });
  });

  it("a body the wire parser cannot represent is a 400 'Invalid request body.' and writes no log row", async () => {
    // An Anthropic document block whose source kind the proxy does not know:
    // the parser refuses it rather than sending the prompt on without it.
    const document = (source: Record<string, unknown>): Record<string, unknown> => ({
      model: "svc",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "text", text: "read this" }, { type: "document", source }] }],
    });

    for (const source of [{ type: "content", content: [] }, { type: "base64", media_type: "application/pdf" }]) {
      const got = await call({ url: "/v1/messages", body: document(source) });
      expect(got.status).toBe(400);
      expect(anthropicError(got.body)).toEqual({ type: "invalid_request_error", message: "Invalid request body." });
      expect(got.upstreamCalls).toBe(0);
      expect(got.logged).toBe(0);
    }
  });

  it("n = 1 is accepted; n = 2 is the first value refused", async () => {
    const one = await call({ body: chat("svc", { n: 1 }) });
    expect(one.status).toBe(200);
    expect(one.upstreamCalls).toBe(1);

    const two = await call({ body: chat("svc", { n: 2 }) });
    expect(two.status).toBe(400);
    expect(openaiError(two.body)).toEqual({
      message: "n > 1 is not supported through this proxy; send one request per completion.", type: "invalid_request_error", code: null, param: null,
    });
    expect(two.upstreamCalls).toBe(0);
    expect(two.logged).toBe(0);
  });

  it("the n check runs before the service lookup: n = 2 on an unknown model is still the 400", async () => {
    const got = await call({ body: chat("ghost", { n: 2 }) });
    expect(got.status).toBe(400);
    expect(got.logged).toBe(0);
  });
});

describe("EP: a service that exists but cannot serve a chat request", () => {
  it("a media-category service on the chat endpoint is a 400 that names its category, and is logged", async () => {
    const got = await call({ body: chat("painter") });

    expect(got.status).toBe(400);
    expect(openaiError(got.body)).toEqual({
      message: "'painter' is a image service; use its dedicated endpoint instead of chat.", type: "invalid_request_error", code: null, param: null,
    });
    expect(got.upstreamCalls).toBe(0);
    expect(got.logged).toBe(1);
    expect(lastLog()).toEqual({
      http_status: 400, error: "'painter' is a image service", service_id: ids.painter, requested_service: "painter", ingress: "openai_completion",
    });
  });

  it("a service whose stored definition is invalid is a 500 that does not leak the parse error", async () => {
    const got = await call({ body: chat("broken") });

    expect(got.status).toBe(500);
    expect(openaiError(got.body)).toEqual({
      message: "Model 'broken' has an invalid definition.", type: "server_error", code: null, param: null,
    });
    expect(got.upstreamCalls).toBe(0);
    expect(got.logged).toBe(1);
    const row = lastLog();
    expect(row).toMatchObject({ http_status: 500, service_id: ids.broken, requested_service: "broken" });
    expect(row.error).toMatch(/^invalid Model Service definition: /);
  });

  it("on the Anthropic endpoint the invalid definition is an api_error", async () => {
    const got = await call({ url: "/v1/messages", body: anthropicChat("broken") });
    expect(got.status).toBe(500);
    expect(anthropicError(got.body)).toEqual({ type: "api_error", message: "Model 'broken' has an invalid definition." });
  });
});

describe("authentication comes before everything else", () => {
  it("no key is a 401 whatever the body says, and nothing is logged", async () => {
    const before = logCount();
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload: JSON.stringify(chat("ghost")) });
    expect(res.statusCode).toBe(401);
    expect(logCount()).toBe(before);
  });

  it("an unknown key is a 401", async () => {
    const got = await call({ key: "sk-not-a-real-key", body: chat("svc") });
    expect(got.status).toBe(401);
    expect(got.upstreamCalls).toBe(0);
  });
});

describe("EP: GET /v1/models", () => {
  const list = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/v1/models", headers });
  // Every enabled service is listed, whatever its category or validity.
  const ENABLED = ["svc", "other", "painter", "broken"];

  it("OpenAI form: a list object of every enabled service, with unix-second timestamps", async () => {
    const res = await list({ authorization: `Bearer ${anyKey}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ object: string; data: Array<{ id: string; object: string; created: number; owned_by: string }> }>();

    expect(Object.keys(body).sort()).toEqual(["data", "object"]);
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual(ENABLED);
    expect(body.data.map((m) => m.id)).not.toContain("off");
    const nowSec = Math.floor(Date.now() / 1000);
    for (const m of body.data) {
      expect(Object.keys(m).sort()).toEqual(["created", "id", "object", "owned_by"]);
      expect(m.object).toBe("model");
      expect(m.owned_by).toBe("hydrogen");
      expect(Number.isInteger(m.created)).toBe(true);
      expect(Math.abs(nowSec - m.created)).toBeLessThan(3_600); // seconds, not milliseconds
    }
  });

  it("Anthropic form (anthropic-version header): a page of models with ISO timestamps and cursors", async () => {
    const res = await list({ "x-api-key": anyKey, "anthropic-version": "2023-06-01" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ type: string; id: string; display_name: string; created_at: string }>; has_more: boolean; first_id: string | null; last_id: string | null }>();

    expect(Object.keys(body).sort()).toEqual(["data", "first_id", "has_more", "last_id"]);
    expect(body.data.map((m) => m.id)).toEqual(ENABLED);
    expect(body.has_more).toBe(false);
    expect(body.first_id).toBe("svc");
    expect(body.last_id).toBe("broken");
    for (const m of body.data) {
      expect(Object.keys(m).sort()).toEqual(["created_at", "display_name", "id", "type"]);
      expect(m.type).toBe("model");
      expect(m.display_name).toBe(m.id);
      expect(new Date(m.created_at).toISOString()).toBe(m.created_at);
    }
  });

  it("the listing is narrowed to a key's service scope", async () => {
    const res = await list({ authorization: `Bearer ${scopedKey}` });
    expect(res.json<{ data: Array<{ id: string }> }>().data.map((m) => m.id)).toEqual(["other"]);
  });

  it("no key is a 401 in the family the headers select", async () => {
    const openai = await list({});
    expect(openai.statusCode).toBe(401);
    expect(openai.json<{ error: { type: string } }>().error.type).toBe("authentication_error");

    const anthropic = await list({ "anthropic-version": "2023-06-01" });
    expect(anthropic.statusCode).toBe(401);
    expect(anthropic.json<{ type: string; error: { type: string } }>()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });

  it("with no enabled service both forms are empty, and the Anthropic cursors are null", async () => {
    for (const name of ENABLED) setEnabled(name, false);
    try {
      const openai = await list({ authorization: `Bearer ${anyKey}` });
      expect(openai.statusCode).toBe(200);
      expect(openai.json()).toEqual({ object: "list", data: [] });

      const anthropic = await list({ "x-api-key": anyKey, "anthropic-version": "2023-06-01" });
      expect(anthropic.statusCode).toBe(200);
      expect(anthropic.json()).toEqual({ data: [], has_more: false, first_id: null, last_id: null });
    } finally {
      for (const name of ENABLED) setEnabled(name, true);
    }
  });

  it("listing models writes no request-log row", async () => {
    const before = logCount();
    await list({ authorization: `Bearer ${anyKey}` });
    expect(logCount()).toBe(before);
  });
});
