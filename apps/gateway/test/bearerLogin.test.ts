/**
 * The admin API is driven by API calls, the console being optional: a login
 * answers with the session token in the body as well as in the cookie, and
 * every session-guarded route accepts that token as an `Authorization:
 * Bearer` header. The public Key Check and logout keep their contracts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const ADMIN_PASSWORD = "bearer-test-admin-pass";

let app: FastifyInstance;
let sqlite: { close: () => void };
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-bearer-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SESSION_SECRET = "bearer-test-session-secret-0123456789";

  const { boot } = await import("../src/composition/container.js");
  const { buildApp } = await import("../src/app.js");
  const c = await boot();
  sqlite = c.sqlite;
  app = await buildApp(c);
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("login returns a bearer-usable token", () => {
  it("answers with the token in the body and the same token in the cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { username: string }; token: string };
    expect(body.user.username).toBe("admin");
    expect(typeof body.token).toBe("string");
    const cookie = res.cookies.find((c) => c.name === "hydrogen_session");
    expect(cookie?.value).toBe(body.token);
  });

  it("authorizes a session-guarded route with Authorization: Bearer and no cookie", async () => {
    const login = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
    const { token } = login.json() as { token: string };

    const me = await app.inject({ method: "GET", url: "/admin/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { username: string } }).user.username).toBe("admin");

    const providers = await app.inject({ method: "GET", url: "/admin/api/providers", headers: { authorization: `Bearer ${token}` } });
    expect(providers.statusCode).toBe(200);
  });

  it("still rejects a request with neither cookie nor bearer, and a bad bearer", async () => {
    const none = await app.inject({ method: "GET", url: "/admin/api/me" });
    expect(none.statusCode).toBe(401);
    const bad = await app.inject({ method: "GET", url: "/admin/api/me", headers: { authorization: "Bearer not-a-session" } });
    expect(bad.statusCode).toBe(401);
  });

  it("keeps the client-key endpoints separate: a session token is not an API key", async () => {
    const login = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
    const { token } = login.json() as { token: string };
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${token}` },
      payload: { model: "anything", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(401);
  });
});
