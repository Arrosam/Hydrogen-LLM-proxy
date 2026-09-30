import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import { boot, type Container } from "../src/composition/container";
import { buildApp } from "../src/app";
import { seedAdminIfEmpty } from "../src/db/bootstrap";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | undefined, c: Container | undefined, dir: string | undefined;
afterEach(async () => { if (app) await app.close(); c?.sqlite.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); app = undefined; c = undefined; dir = undefined; vi.unstubAllEnvs(); });
async function instance(password = "admin-test-password", trustProxy = "false") {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-http-review-"));
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("DATA_DIR", dir); vi.stubEnv("ADMIN_PASSWORD", password);
  vi.stubEnv("SESSION_SECRET", "review-http-secret-1234567890123456789"); vi.stubEnv("TRUST_PROXY", trustProxy); vi.stubEnv("COOKIE_SECURE", "auto");
  c = await boot(); app = await buildApp(c);
  return { app, c };
}
async function login(app: FastifyInstance, username: string, password: string, headers: Record<string, string> = {}) {
  const response = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username, password }, headers });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find(cookie => cookie.name === "hydrogen_session")!;
  return { response, cookie: `${cookie.name}=${cookie.value}`, token: cookie.value };
}

describe("HTTP authorization and restore regressions", () => {
  it("limits first-login sessions to password setup and never publishes credentials", async () => {
    const { app, c } = await instance();
    c.sqlite.prepare("DELETE FROM users").run();
    const seed = await seedAdminIfEmpty(c.db, { username: "admin", password: "" });
    const { cookie } = await login(app, "admin", seed.password!);
    expect((await app.inject("/admin/api/setup-info")).json()).toEqual({ initial: null });
    for (const url of ["/admin/api/tokens", "/admin/api/backup/export", "/admin/api/providers"]) {
      expect((await app.inject({ method: "POST", url, payload: {}, headers: { cookie } })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: "/admin/api/me", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/admin/api/change-password", headers: { cookie }, payload: { newPassword: "changed-password", currentPassword: seed.password } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/admin/api/me", headers: { cookie } })).statusCode).toBe(401);
  });
  it("applies runtime TTL and revokes copied cookies on password change/logout", async () => {
    const { app, c } = await instance();
    c.settings.setSessionTtlMs(60_000);
    const first = await login(app, "admin", "admin-test-password");
    const claims = jwt.decode(first.token) as jwt.JwtPayload;
    expect(claims.exp! - claims.iat!).toBe(60); expect(first.response.cookies[0].maxAge).toBe(60);
    const changed = await app.inject({ method: "POST", url: "/admin/api/change-password", headers: { cookie: first.cookie }, payload: { newPassword: "second-password", currentPassword: "admin-test-password" } });
    expect(changed.statusCode).toBe(200);
    expect((await app.inject({ url: "/admin/api/me", headers: { cookie: first.cookie } })).statusCode).toBe(401);
    const second = await login(app, "admin", "second-password");
    expect((await app.inject({ method: "POST", url: "/admin/api/logout", headers: { cookie: second.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/admin/api/me", headers: { cookie: second.cookie } })).statusCode).toBe(401);
  });
  it("trusts exactly one forwarded hop and marks TLS cookies Secure", async () => {
    const { app } = await instance("admin-test-password", "1");
    app.get("/proxy-info", req => ({ ip: req.ip, protocol: req.protocol }));
    const proxyInfo = await app.inject({ url: "/proxy-info", headers: { "x-forwarded-proto": "https", "x-forwarded-for": "1.1.1.1, 8.8.8.8" } });
    expect(proxyInfo.json()).toEqual({ ip: "8.8.8.8", protocol: "https" });
    const { response } = await login(app, "admin", "admin-test-password", { "x-forwarded-proto": "https", "x-forwarded-for": "1.1.1.1, 8.8.8.8" });
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(c!.config.trustProxy).toBe(1);
  });
  it("hides provider headers and denies manager proxy/test credential use", async () => {
    const { app, c } = await instance();
    await c.users.create({ username: "manager", password: "manager-password", role: "manager" });
    const provider = c.providers.create({ name: "provider", type: "openai_completion", baseUrl: "https://example.com/v1", apiKey: "provider-secret", extraHeaders: { "x-gateway-key": "header-secret" } });
    const proxy = c.proxies.create({ name: "proxy", scheme: "http", host: "127.0.0.1", port: 1234 });
    const manager = await login(app, "manager", "manager-password");
    const providers = await app.inject({ url: "/admin/api/providers", headers: { cookie: manager.cookie } });
    expect(providers.payload).not.toContain("header-secret");
    const test = await app.inject({ method: "POST", url: "/admin/api/providers/test", headers: { cookie: manager.cookie }, payload: { type: "openai_completion", baseUrl: "http://127.0.0.1", apiKey: "own", proxyId: proxy.id } });
    expect(test.statusCode).toBe(403);
    for (const url of ["/admin/api/bench/chat", "/admin/api/bench/media", "/admin/api/services/test", "/admin/api/services/test-ocr"]) expect((await app.inject({ method: "POST", url, headers: { cookie: manager.cookie }, payload: {} })).statusCode).toBe(403);
    const admin = await login(app, "admin", "admin-test-password");
    const adminProviders = await app.inject({ url: "/admin/api/providers", headers: { cookie: admin.cookie } });
    expect(adminProviders.json().providers.find((p: { id: number }) => p.id === provider.id).extraHeaders["x-gateway-key"]).toBe("header-secret");
  });
  it("blocks request admission while restore is awaiting passphrase verification", async () => {
    const { app, c } = await instance(); const { cookie } = await login(app, "admin", "admin-test-password");
    const exported = await app.inject({ method: "POST", url: "/admin/api/backup/export", headers: { cookie }, payload: { passphrase: "backup-password", includeLogs: false } });
    expect(exported.statusCode).toBe(200);
    const restore = app.inject({ method: "POST", url: "/admin/api/backup/restore", headers: { cookie }, payload: { passphrase: "backup-password", backup: exported.json().backup } });
    await vi.waitFor(async () => { expect((await app.inject("/healthz")).statusCode).toBe(503); }, { timeout: 1000, interval: 1 });
    expect((await restore).statusCode).toBe(200);
    expect(c.requestGate.activeCount).toBe(0);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
  });
});
