import { beforeAll, afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Container } from "../src/composition/container";
let app: FastifyInstance;
let c: Container;
let dataDir: string;
const password = "temporary-test-password";
beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-audit-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = password;
  process.env.SESSION_SECRET = "audit-test-session-secret-0123456789";
  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  c = await boot();
  await c.users.create({ username: "setup", password, role: "admin", mustChangePassword: true });
  app = await buildApp(c);
});
afterAll(async () => { await app?.close(); c?.sqlite.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
it("does not disclose setup credentials", async () => {
  const r = await app.inject({ url: "/admin/api/setup-info" });
  expect(r.json()).toEqual({ initial: null });
});
it("limits setup sessions, requires current password, and invalidates the old setup cookie", async () => {
  const login = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: "setup", password } });
  const session = login.cookies.find(c => c.name === "hydrogen_session")!;
  const cookie = `${session.name}=${session.value}`;
  expect((await app.inject({ url: "/admin/api/users", headers: { cookie } })).statusCode).toBe(403);
  expect((await app.inject({ url: "/admin/api/me", headers: { cookie } })).statusCode).toBe(200);
  const change = (currentPassword?: string) => app.inject({ method: "POST", url: "/admin/api/change-password", headers: { cookie }, payload: { newPassword: "new-audit-password", currentPassword } });
  expect((await change()).statusCode).toBe(400);
  expect((await change("wrong")).statusCode).toBe(400);
  const changed = await change(password);
  expect(changed.statusCode).toBe(200);
  const fresh = changed.cookies.find(c => c.name === "hydrogen_session")!;
  expect((await app.inject({ url: "/admin/api/users", headers: { cookie: `${fresh.name}=${fresh.value}` } })).statusCode).toBe(200);
  expect((await app.inject({ url: "/admin/api/me", headers: { cookie } })).statusCode).toBe(401);
});

it("adds browser security headers without blocking API JSON", async()=>{
 const r=await app.inject({url:"/admin/api/setup-info"});expect(r.headers["x-content-type-options"]).toBe("nosniff");expect(r.headers["x-frame-options"]).toBe("DENY");
 const page=await app.inject({url:"/"});expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
});

it("keeps key status useful without exposing internal owner/service identifiers",async()=>{
 const {secret}=c.tokens.create({name:"status-test",maxRequests:0});
 const r=await app.inject({method:"POST",url:"/admin/api/check",payload:{apiKey:secret}});
 expect(r.statusCode).toBe(200);expect(r.headers["cache-control"]).toBe("no-store");
 expect(r.json().status).toMatchObject({valid:false,requestsExceeded:true});
 expect(r.json().key).toMatchObject({maxRequests:0,scopeServiceCount:0});
 for(const field of ["id","ownerUserId","scopeServices","keyPrefix","keyHash","keyCiphertext"]) expect(r.json().key).not.toHaveProperty(field);
 expect((await app.inject({method:"POST",url:"/admin/api/check",payload:{apiKey:"wrong"}})).statusCode).toBe(401);
});
