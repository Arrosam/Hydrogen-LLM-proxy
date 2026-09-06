/**
 * Log export: the file an operator downloads to hand an agent a corpus.
 *
 * The behaviours pinned here are the ones that would fail silently and be
 * discovered only by an agent reading a wrong file: rows chosen by filter vs by
 * hand-picked id, the payloads actually being present, LIKE wildcards typed by
 * an operator being treated as literal text rather than matching everything,
 * and the whole surface staying admin-only. The stream is also parsed back as
 * JSON, because an envelope written by hand around a streamed array is exactly
 * the kind of thing that stays valid until it doesn't.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { LogInsert } from "../src/persistence/requestLogRepo";

const ADMIN_PASSWORD = "log-export-admin-pass";
const MANAGER_PASSWORD = "log-export-manager-pass";

let app: FastifyInstance;
let sqlite: { close: () => void };
let dataDir: string;
let adminCookie: string;
let managerCookie: string;
let ids: number[] = [];

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  const session = res.cookies.find((c) => c.name === "hydrogen_session");
  expect(session).toBeTruthy();
  return `${session!.name}=${session!.value}`;
}

function row(over: Partial<LogInsert>): LogInsert {
  return {
    traceId: `trace-${Math.random().toString(36).slice(2)}`,
    tokenId: null,
    serviceId: null,
    requestedService: "svc",
    servedModel: null,
    servedProvider: null,
    ingressFormat: "openai_completion",
    egressFormat: "openai_completion",
    streaming: false,
    httpStatus: 200,
    requestMethod: "POST",
    requestPath: "/v1/chat/completions",
    requestQuery: null,
    requestHeaders: null,
    requestBody: null,
    upstreamRequestBody: null,
    responseHeaders: null,
    responseBody: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    latencyMs: 1,
    attempts: 1,
    attemptPath: null,
    error: null,
    ...over,
  };
}

type Export = {
  exportedAt: string;
  hydrogenVersion: string;
  selection: { mode: string; filters: Record<string, unknown> };
  count: number;
  logs: Array<Record<string, unknown>>;
};

async function exportAs(cookie: string, query = ""): Promise<{ status: number; body: string; disposition?: string }> {
  const res = await app.inject({
    method: "GET",
    url: `/admin/api/logs/export${query ? `?${query}` : ""}`,
    headers: { cookie },
  });
  return {
    status: res.statusCode,
    body: res.body,
    disposition: res.headers["content-disposition"] as string | undefined,
  };
}

async function exported(query = ""): Promise<Export> {
  const r = await exportAs(adminCookie, query);
  expect(r.status).toBe(200);
  return JSON.parse(r.body) as Export;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-logexport-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SESSION_SECRET = "log-export-session-secret-0123456789";

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await boot();
  await c.users.create({ username: "mgr", password: MANAGER_PASSWORD, role: "manager", enabled: true });
  sqlite = c.sqlite;

  ids = [
    c.logs.insert(row({ servedModel: "alpha", requestBody: '{"messages":[{"role":"user","content":"one"}]}' })),
    c.logs.insert(row({ servedModel: "beta", httpStatus: 500, error: "upstream exploded" })),
    c.logs.insert(row({ servedModel: "alpha", httpStatus: 404, error: "unknown model 'ghost'" })),
    // Wildcards inside real error text: a broken LIKE escape makes searching for
    // "_" or "%" match every one of these instead of just this row.
    c.logs.insert(row({ servedModel: "beta", httpStatus: 400, error: "bad_param: over 100% of quota" })),
  ];

  app = await buildApp(c);
  adminCookie = await login("admin", ADMIN_PASSWORD);
  managerCookie = await login("mgr", MANAGER_PASSWORD);
});

afterAll(() => {
  sqlite?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("log export", () => {
  it("streams a valid JSON envelope carrying every matching row", async () => {
    const doc = await exported();
    expect(doc.count).toBe(4);
    expect(doc.logs).toHaveLength(4);
    expect(doc.selection.mode).toBe("filter");
    expect(typeof doc.hydrogenVersion).toBe("string");
    expect(Number.isFinite(Date.parse(doc.exportedAt))).toBe(true);
    // Newest first, matching the list it was launched from.
    expect(doc.logs.map((l) => l.id)).toEqual([...ids].reverse());
  });

  it("carries the full payloads, which is the whole point of the file", async () => {
    const doc = await exported(`ids=${ids[0]}`);
    expect(doc.logs).toHaveLength(1);
    expect(doc.logs[0]!.requestBody).toBe('{"messages":[{"role":"user","content":"one"}]}');
    // Fields the summary list never carries.
    expect(doc.logs[0]).toHaveProperty("upstreamRequestBody");
    expect(doc.logs[0]).toHaveProperty("responseBody");
    expect(doc.logs[0]).toHaveProperty("traceId");
  });

  it("exports exactly the hand-picked rows, in any order they were ticked", async () => {
    const picked = [ids[0]!, ids[2]!];
    const doc = await exported(`ids=${picked[1]},${picked[0]}`);
    expect(doc.selection.mode).toBe("ids");
    expect(doc.count).toBe(2);
    expect(doc.logs.map((l) => l.id).sort()).toEqual([...picked].sort());
  });

  it("filters by the model that actually served the request", async () => {
    const doc = await exported("servedModel=alpha");
    expect(doc.count).toBe(2);
    expect(doc.logs.every((l) => l.servedModel === "alpha")).toBe(true);
  });

  it("filters by error substring, case-insensitively", async () => {
    expect((await exported("errorContains=exploded")).count).toBe(1);
    expect((await exported("errorContains=EXPLODED")).count).toBe(1);
    expect((await exported("errorContains=no-such-text")).count).toBe(0);
  });

  it("treats LIKE wildcards the operator typed as literal text", async () => {
    // Three rows have an error. If "%" or "_" leaked into the pattern as a
    // wildcard, each of these would match all three instead of the one row
    // whose text actually contains that character.
    expect((await exported("errorsOnly=true")).count).toBe(3);
    expect((await exported(`errorContains=${encodeURIComponent("%")}`)).count).toBe(1);
    expect((await exported("errorContains=_")).count).toBe(1);
    expect((await exported(`errorContains=${encodeURIComponent("100%")}`)).count).toBe(1);
    expect((await exported(`errorContains=${encodeURIComponent("%%%")}`)).count).toBe(0);
  });

  it("composes ids with the other filters rather than overriding them", async () => {
    const doc = await exported(`ids=${ids.join(",")}&servedModel=beta`);
    expect(doc.count).toBe(2);
    expect(doc.logs.every((l) => l.servedModel === "beta")).toBe(true);
  });

  it("offers the file as a download", async () => {
    const r = await exportAs(adminCookie);
    expect(r.disposition).toMatch(/^attachment; filename="hydrogen-logs-.*\.json"$/);
  });

  it("is admin-only, like every other way of reading a conversation", async () => {
    expect((await exportAs(managerCookie)).status).toBe(403);
    expect((await exportAs("")).status).toBe(401);

    const models = await app.inject({ method: "GET", url: "/admin/api/logs/models", headers: { cookie: managerCookie } });
    expect(models.statusCode).toBe(403);
  });

  it("lists the distinct served models for the filter dropdown", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/logs/models", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ models: ["alpha", "beta"] });
  });

  it("accepts a repeated ids key instead of throwing", async () => {
    // Fastify parses `?ids=1&ids=2` into an array; assuming a string here turned
    // the most natural way to send a list into a 500.
    const doc = await exported(`ids=${ids[0]}&ids=${ids[2]}`);
    expect(doc.selection.mode).toBe("ids");
    expect(doc.count).toBe(2);
    expect(doc.logs.map((l) => l.id).sort()).toEqual([ids[0], ids[2]].sort());
  });

  it("stays valid JSON when nothing matches", async () => {
    const doc = await exported("servedModel=nothing-served-this");
    expect(doc.count).toBe(0);
    expect(doc.logs).toEqual([]);
  });
});
