/** Jev and Laya speak System One, not chat completions or /classify. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { Container } from "../src/composition/container";
import { systemOneUrl } from "../src/core/upstream/endpoints";
import { fuzzyRewriteUrl } from "../src/transport/fuzzyUrl";

interface Hit { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
type Handler = (hit: Hit, res: http.ServerResponse) => void;
const QUESTIONS = {
  department: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "Payments and refunds", technical: null } },
  urgency: { type: "score", instructions: { question: "How urgent?", rubric: "Customer impact" }, criteria: ["Not urgent", "Blocking"] },
  refund: { type: "noul", instructions: "Does the user request a refund?", criteria: { true: "Explicit request", false: "No request" } },
};
const ANSWER = {
  model: "jev-1.13.0",
  answers: {
    department: { type: "choice", choice: "billing", probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.8 },
    urgency: { type: "score", score: 0.75, legend: { "0": "Not urgent", "1": "Blocking" }, probabilities: { "0": 0.25, "1": 0.75 }, confidence: 0.5 },
    refund: { type: "noul", noul: 0.95 },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
};
const LAYA_ANSWER = {
  ...ANSWER,
  model: "laya-rl-agent",
  answers: {
    ...ANSWER.answers,
    refund: { ...ANSWER.answers.refund, confidence: 0.95, answer_confidence: 0.95, action: { act_probability: 0.8 } },
  },
  usage: { input_tokens: 512, output_tokens: 0, state_tokens: 16, state_tokens_dropped: 0, truncated: false, truncated_questions: [] },
  routing: { model: "multilingual", repo: "convaiinnovations/laya-multilingual", reason: "explicit override", detection: null, workflow: null },
};
const STATE = { body: "I was billed twice. Please refund the duplicate today." };
const json = (status: number, body: unknown): Handler => (_hit, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

let app: FastifyInstance;
let c: Container;
let upstream: http.Server;
let dataDir: string;
let baseUrl: string;
let secret: string;
let cookie: string;
let hits: Hit[] = [];
let handler: Handler;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-classification-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "classification-test-password";
  process.env.SESSION_SECRET = "classification-test-session-secret";
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const hit = { url: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> };
      hits.push(hit);
      handler(hit, res);
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  c = await boot();
  const jev = c.providers.create({ name: "typesafe", type: "openai_completion", baseUrl: `${baseUrl}/jev/v1`, apiKey: "jev-key" });
  const laya = c.providers.create({
    name: "laya", type: "anthropic", baseUrl: "http://127.0.0.1:9/anthropic", apiKey: "laya-key",
    altEndpoints: [{ type: "openai_responses", baseUrl: `${baseUrl}/laya/v1` }],
  });
  const anthro = c.providers.create({ name: "anthro-only", type: "anthropic", baseUrl: "http://127.0.0.1:9/anthropic" });
  const local = c.providers.create({ name: "laya-no-key", type: "openai_completion", baseUrl: `${baseUrl}/local/v1` });
  const model = c.models.create({ name: "decisions" });
  c.mappings.create({ modelId: model.id, providerId: jev.id, upstreamModel: "jev-latest" });
  c.mappings.create({ modelId: model.id, providerId: laya.id, upstreamModel: "multilingual", families: ["anthropic", "openai_responses"] });
  c.mappings.create({ modelId: model.id, providerId: anthro.id, upstreamModel: "not-systemone" });
  c.mappings.create({ modelId: model.id, providerId: local.id, upstreamModel: "english" });
  const step = { model: "decisions", provider: "typesafe", retry: { maxAttempts: 1 } };
  c.services.create({ name: "triage", definition: { category: "classification", timeoutMs: 10_000, steps: [step] } });
  c.services.create({ name: "triage-laya", definition: { category: "classification", timeoutMs: 10_000, steps: [{ ...step, provider: "laya" }] } });
  c.services.create({ name: "triage-local", definition: { category: "classification", timeoutMs: 10_000, steps: [{ ...step, provider: "laya-no-key" }] } });
  c.services.create({ name: "triage-params", definition: {
    category: "classification", timeoutMs: 10_000,
    steps: [{ ...step, provider: "laya", overrides: { extra: { max_len: 8192, lang: "de", model: "hijack" } } }],
  } });
  c.services.create({ name: "triage-fallback", definition: {
    category: "classification", timeoutMs: 10_000,
    steps: [
      { ...step, retry: { maxAttempts: 2, on: [529], intervalMs: 0 }, advanceOn: ["exhausted"] },
      { ...step, provider: "laya" },
    ],
  } });
  c.services.create({ name: "chat", definition: { timeoutMs: 10_000, steps: [step] } });
  c.services.create({ name: "agent", definition: { kind: "micro_agent", timeoutMs: 10_000, stages: [{ name: "s1", service: "chat", input: [] }] } });
  secret = c.tokens.create({ name: "classification-client" }).secret;
  app = await buildApp(c);
  const login = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: "admin", password: "classification-test-password" } });
  const session = login.cookies.find(x => x.name === "hydrogen_session")!;
  cookie = `${session.name}=${session.value}`;
});

beforeEach(() => { hits = []; handler = json(200, ANSWER); });
afterAll(async () => {
  await app?.close();
  if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()));
  c?.sqlite.close();
  if (dataDir && path.dirname(path.resolve(dataDir)) === path.resolve(os.tmpdir()) && path.basename(dataDir).startsWith("hydrogen-classification-")) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
const auth = (key = secret) => ({ authorization: `Bearer ${key}` });
const post = (model = "triage", body: Record<string, unknown> = {}, url = "/v1/systemone", key = secret) =>
  app.inject({ method: "POST", url, headers: auth(key), payload: { model, state: STATE, questions: QUESTIONS, ...body } });
const bench = (payload: unknown) => app.inject({ method: "POST", url: "/admin/api/bench/media", headers: { cookie }, payload: payload as never });

describe("classification category and endpoint selection", () => {
  it("validates and summarizes classification services, including enabled OpenAI alternates", () => {
    for (const name of ["triage", "triage-laya"]) {
      expect(c.validator.validate(c.services.getByName(name)!.definition).summary).toContain("[classification]");
    }
  });

  it("rejects Anthropic-only mappings at save time and does not translate decisions into chat", () => {
    expect(() => c.validator.validate({ category: "classification", steps: [{ model: "decisions", provider: "anthro-only" }] }))
      .toThrow(/classification services require an OpenAI-compatible endpoint/);
  });

  it("excludes classification from Micro Agent stages, OCR, and the chat runtime resolver", () => {
    expect(() => c.validator.validate({ kind: "micro_agent", stages: [{ name: "s", service: "triage", input: [] }] }))
      .toThrow(/classification service — only chat\/OCR/);
    expect(() => c.validator.validate({ kind: "micro_agent", stages: [{ name: "s", service: "chat", input: [] }], ocr: { service: "triage" } }))
      .toThrow(/classification service — it must be a chat or OCR/);
    const result = c.factory.resolve("triage");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("classification service");
  });

  it("keeps the configured API prefix and query when building System One URLs", () => {
    const p = { type: "openai_completion" as const, baseUrl: "https://host.test/prefix/v1/?tenant=a", apiKey: null };
    expect(systemOneUrl(p)).toBe("https://host.test/prefix/v1/systemone?tenant=a");
    expect(systemOneUrl(p, "/batch")).toBe("https://host.test/prefix/v1/systemone/batch?tenant=a");
  });

  it("recognizes missing-prefix and doubled-slash System One paths", () => {
    expect(fuzzyRewriteUrl("POST", "/systemone", {})).toBe("/v1/systemone");
    expect(fuzzyRewriteUrl("POST", "/api//v1/systemone/batch?x=1", {})).toBe("/v1/systemone/batch?x=1");
    expect(fuzzyRewriteUrl("POST", "/admin/api/systemone", {})).toBe("/admin/api/systemone");
  });
});

describe("native typed-decision passthrough", () => {
  it("forwards structured state and all three question types; preserves probabilities and usage", async () => {
    const r = await post();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(ANSWER);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe("/jev/v1/systemone");
    expect(hits[0].body).toEqual({ model: "jev-latest", state: STATE, questions: QUESTIONS });
    expect(hits[0].headers.authorization).toBe("Bearer jev-key");
  });

  it("preserves text and conversation-array states rather than parsing them as messages", async () => {
    for (const state of ["Please refund my invoice", [{ role: "user", content: "Refund please" }]]) {
      const r = await post("triage", { state });
      expect(r.statusCode).toBe(200);
      expect(hits.at(-1)!.body.state).toEqual(state);
    }
  });

  it("uses the enabled Laya alternate's URL and Bearer auth, not its Anthropic primary", async () => {
    const r = await post("triage-laya");
    expect(r.statusCode).toBe(200);
    expect(hits[0].url).toBe("/laya/v1/systemone");
    expect(hits[0].headers.authorization).toBe("Bearer laya-key");
    expect(hits[0].headers["x-api-key"]).toBeUndefined();
    expect(hits[0].body.model).toBe("multilingual");
  });

  it("supports unauthenticated local Laya upstreams without leaking the client token", async () => {
    handler = json(200, LAYA_ANSWER);
    const r = await post("triage-local");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(LAYA_ANSWER);
    expect(hits[0].url).toBe("/local/v1/systemone");
    expect(hits[0].headers.authorization).toBeUndefined();
    expect(hits[0].headers["x-api-key"]).toBeUndefined();
    expect(c.logs.query({ limit: 1 }).rows[0]).toMatchObject({ promptTokens: 512, completionTokens: 0, totalTokens: 512 });
  });

  it("forwards provider-specific fields and step overrides but always pins the mapped model", async () => {
    handler = json(200, { ...ANSWER, model: "laya", routing: { model: "multilingual", reason: "explicit override" } });
    const r = await post("triage-params", { max_len: 512, min_confidence: 0.7 });
    expect(r.statusCode).toBe(200);
    expect(r.json().routing).toEqual({ model: "multilingual", reason: "explicit override" });
    expect(hits[0].body).toMatchObject({ max_len: 8192, lang: "de", min_confidence: 0.7, model: "multilingual" });
  });

  it("records native answers, input/output usage, and client quota", async () => {
    const token = c.tokens.authenticate(secret)!;
    const r = await post();
    expect(r.statusCode).toBe(200);
    const row = c.logs.query({ limit: 1 }).rows[0];
    expect(row).toMatchObject({ serviceName: "triage", promptTokens: 318, completionTokens: 34, totalTokens: 352 });
    expect(JSON.parse(c.logs.get(row.id)!.responsePayload!)).toEqual(ANSWER);
    expect(c.tokens.get(token.id)!.usedTokens - token.usedTokens).toBe(352);
    expect(c.tokens.get(token.id)!.usedRequests - token.usedRequests).toBe(1);
  });

  it("retries overloads then falls back between Jev and Laya with the same questions", async () => {
    handler = (hit, res) => json(hit.body.model === "jev-latest" ? 529 : 200,
      hit.body.model === "jev-latest" ? { error: { message: "temporarily overloaded" } } : ANSWER)(hit, res);
    const r = await post("triage-fallback");
    expect(r.statusCode).toBe(200);
    expect(hits.map(hit => hit.body.model)).toEqual(["jev-latest", "jev-latest", "multilingual"]);
    expect(hits.map(hit => hit.body.questions)).toEqual([QUESTIONS, QUESTIONS, QUESTIONS]);
    expect(c.logs.query({ limit: 1 }).rows[0].attempts).toBe(3);
  });

  it("propagates upstream validation status without fabricating a decision", async () => {
    handler = json(422, { error: { message: "Malformed choice criteria" } });
    const r = await post("triage", { questions: { q: { type: "choice", instructions: "Which?" } } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Malformed choice criteria");
    expect(hits).toHaveLength(1);
  });

  it("surfaces native Laya FastAPI detail errors and keeps the raw evidence", async () => {
    handler = json(422, { detail: "head_max_len must not exceed max_len" });
    const r = await post("triage-laya");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("head_max_len must not exceed max_len");
    const row = c.logs.query({ limit: 1 }).rows[0];
    expect(JSON.parse(c.logs.get(row.id)!.responsePayload!)).toEqual({ detail: "head_max_len must not exceed max_len" });
  });

  it("summarizes validation detail arrays without echoing their rejected input", async () => {
    handler = json(422, { detail: [{ loc: ["body", "questions", "department", "criteria"], msg: "Field required", input: "private-state" }] });
    const r = await post("triage-laya");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("body.questions.department.criteria: Field required");
    expect(r.payload).not.toContain("private-state");
  });

  it("treats missing or invalid upstream usage as zero, never negative quota", async () => {
    const token = c.tokens.authenticate(secret)!;
    handler = json(200, { ...ANSWER, usage: { input_tokens: -100, output_tokens: "34" } });
    expect((await post()).statusCode).toBe(200);
    expect(c.tokens.get(token.id)!.usedTokens).toBe(token.usedTokens);
    expect(c.logs.query({ limit: 1 }).rows[0].totalTokens).toBe(0);
    for (const body of [{ answers: {} }, { ...ANSWER, usage: { input_tokens: null, output_tokens: null } }]) {
      handler = json(200, body);
      const r = await post();
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual(body);
      expect(c.logs.query({ limit: 1 }).rows[0].totalTokens).toBe(0);
    }
  });
});

describe("Laya batched-state extension", () => {
  it("preserves result order and meters aggregate total_usage exactly once", async () => {
    const batch = { results: [LAYA_ANSWER, { ...LAYA_ANSWER, usage: { ...LAYA_ANSWER.usage, input_tokens: 124 } }], total_usage: { input_tokens: 636, output_tokens: 0 } };
    handler = json(200, batch);
    const token = c.tokens.authenticate(secret)!;
    const r = await app.inject({ method: "POST", url: "/v1/systemone/batch", headers: auth(), payload: {
      model: "triage-laya", states: [STATE, "Cannot log in"], questions: QUESTIONS,
    } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(batch);
    expect(hits[0].url).toBe("/laya/v1/systemone/batch");
    expect(hits[0].body).toEqual({ model: "multilingual", states: [STATE, "Cannot log in"], questions: QUESTIONS });
    expect(c.tokens.get(token.id)!.usedTokens - token.usedTokens).toBe(636);
    expect(c.tokens.get(token.id)!.usedRequests - token.usedRequests).toBe(1);
    expect(c.logs.query({ limit: 1 }).rows[0]).toMatchObject({ promptTokens: 636, completionTokens: 0, totalTokens: 636 });
  });

  it("authenticates and scope-checks batches just like single-state calls", async () => {
    const payload = { model: "triage-laya", states: [STATE], questions: QUESTIONS };
    expect((await app.inject({ method: "POST", url: "/v1/systemone/batch", payload })).statusCode).toBe(401);
    const restricted = c.tokens.create({ name: "batch-restricted", scopeServices: [c.services.getByName("chat")!.id] });
    expect((await app.inject({ method: "POST", url: "/v1/systemone/batch", headers: auth(restricted.secret), payload })).statusCode).toBe(403);
    const exhausted = c.tokens.create({ name: "batch-exhausted", maxRequests: 0 });
    expect((await app.inject({ method: "POST", url: "/v1/systemone/batch", headers: auth(exhausted.secret), payload })).statusCode).toBe(429);
    expect(hits).toHaveLength(0);
  });

  it("does not emulate a batch API for an upstream that does not provide it", async () => {
    handler = json(404, { error: { message: "Batch endpoint not supported" } });
    expect((await post("triage", { states: [STATE] }, "/v1/systemone/batch")).statusCode).toBe(404);
    expect(hits[0].url).toBe("/jev/v1/systemone/batch");
  });
});

describe("authorization and category isolation", () => {
  it("requires an enabled client token and honors token service scope and quotas", async () => {
    const unauthenticated = await app.inject({ method: "POST", url: "/v1/systemone", payload: { model: "triage" } });
    expect(unauthenticated.statusCode).toBe(401);
    const restricted = c.tokens.create({ name: "restricted", scopeServices: [c.services.getByName("chat")!.id] });
    expect((await post("triage", {}, "/v1/systemone", restricted.secret)).statusCode).toBe(403);
    const exhausted = c.tokens.create({ name: "exhausted", maxTokens: 0 });
    expect((await post("triage", {}, "/v1/systemone", exhausted.secret)).statusCode).toBe(429);
    expect(hits).toHaveLength(0);
  });

  it("rejects missing, unknown, disabled and wrong-category model services before sending", async () => {
    expect((await post("")).statusCode).toBe(400);
    expect((await post("unknown")).statusCode).toBe(404);
    for (const model of ["chat", "agent"]) expect((await post(model)).statusCode).toBe(400);
    const row = c.services.create({ name: "off", enabled: false, definition: c.services.getByName("triage")!.definition });
    expect((await post(row.name)).statusCode).toBe(404);
    expect(hits).toHaveLength(0);
  });

  it("points other non-chat endpoints at System One and refuses chat invocation", async () => {
    const r = await post("triage", {}, "/v1/embeddings");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("/v1/systemone");
    const chat = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: auth(), payload: { model: "triage", messages: [{ role: "user", content: "hello" }] } });
    expect(chat.statusCode).toBe(400);
    expect(chat.json().error.message).toContain("classification service");
    expect(hits).toHaveLength(0);
  });
});

describe("internal Model Bench", () => {
  it("lists classification services and probes a raw mapped target on its native route", async () => {
    const targets = await app.inject({ method: "GET", url: "/admin/api/bench/targets", headers: { cookie } });
    expect(targets.json().services.find((s: { name: string }) => s.name === "triage")).toMatchObject({ category: "classification", valid: true });
    const before = c.logs.query({ limit: 1 }).total;
    const r = await bench({ target: { kind: "raw", model: "decisions", provider: "typesafe", providerFormat: "openai_completion" }, category: "classification", body: { model: "placeholder", state: STATE, questions: QUESTIONS } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, response: ANSWER, upstreamRequest: { model: "jev-latest", state: STATE, questions: QUESTIONS } });
    expect(hits[0].url).toBe("/jev/v1/systemone");
    expect(c.logs.query({ limit: 1 }).total).toBe(before);
  });

  it("probes a saved service through its enabled alternate and rejects Anthropic probes", async () => {
    const r = await bench({ target: { kind: "service", serviceId: c.services.getByName("triage-laya")!.id }, category: "classification", body: { state: STATE, questions: QUESTIONS } });
    expect(r.json().ok).toBe(true);
    expect(hits[0].url).toBe("/laya/v1/systemone");
    const rejected = await bench({ target: { kind: "raw", model: "decisions", provider: "laya", providerFormat: "anthropic" }, category: "classification", body: { state: STATE, questions: QUESTIONS } });
    expect(rejected.statusCode).toBe(400);
    expect(hits).toHaveLength(1);
  });

  it("reports native Laya failures with their validation message", async () => {
    handler = json(422, { detail: "Invalid score criteria" });
    const r = await bench({ target: { kind: "service", serviceId: c.services.getByName("triage-laya")!.id }, category: "classification", body: { state: STATE, questions: QUESTIONS } });
    expect(r.json()).toMatchObject({ ok: false, status: 422, message: "Invalid score criteria", response: { detail: "Invalid score criteria" } });
  });
});
