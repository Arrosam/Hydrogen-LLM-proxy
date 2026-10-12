/**
 * Characterization of the session routes (login / logout / me /
 * change-password / setup-info) and of the public key self-check: every
 * rejection partition of a login, and the status matrix of /check.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_PASSWORD, MANAGER_PASSWORD, startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;
let ip = 0;

beforeAll(async () => {
  h = await startAdminHarness("cov-auth");
});

afterAll(async () => {
  await h.close();
});

/** A login attempt from an address of its own, so the per-address limit never interferes. */
const login = (payload: unknown, remoteAddress = `10.50.0.${++ip}`) => h.app.inject({ method: "POST", url: "/admin/api/login", payload: payload as never, remoteAddress });
const sessionCookie = (res: Awaited<ReturnType<typeof login>>) => res.cookies.find((c) => c.name === "hydrogen_session");

describe("POST /login", () => {
  it("success: 200 {user}, and an httpOnly session cookie scoped to /", async () => {
    const res = await login({ username: "admin", password: ADMIN_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: 1, username: "admin", role: "admin", enabled: true, mustChangePassword: false, createdAt: expect.any(Number) } });
    expect(res.body).not.toContain(ADMIN_PASSWORD);
    expect(sessionCookie(res)).toMatchObject({ httpOnly: true, path: "/" });
    expect(sessionCookie(res)!.value.length).toBeGreaterThan(20);
  });

  it("a wrong password, an unknown user and a disabled user are the same 401, with no cookie", async () => {
    await h.c.users.create({ username: "off", password: "disabled-user-pass", role: "manager", enabled: false });
    const attempts = [
      { username: "admin", password: "not-the-password" },
      { username: "nobody", password: ADMIN_PASSWORD },
      { username: "off", password: "disabled-user-pass" },
      { username: "ADMIN", password: ADMIN_PASSWORD },
    ];
    for (const payload of attempts) {
      const res = await login(payload);
      expect(res.statusCode, payload.username).toBe(401);
      expect(res.json()).toEqual({ error: "invalid credentials" });
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("a disabled user can sign in again once re-enabled", async () => {
    const id = h.c.users.getByUsername("off")!.id;
    await h.c.users.update(id, { enabled: true });
    expect((await login({ username: "off", password: "disabled-user-pass" })).statusCode).toBe(200);
  });

  it("a malformed body is 400 `path: message`", async () => {
    const cases: Array<[unknown, string]> = [
      [{ username: "", password: "x" }, "username: String must contain at least 1 character(s)"],
      [{ username: "admin", password: "" }, "password: String must contain at least 1 character(s)"],
      [{ username: "admin" }, "password: Required"],
      [{}, "username: Required; password: Required"],
      [{ username: 1, password: 2 }, "username: Expected string, received number; password: Expected string, received number"],
    ];
    for (const [payload, error] of cases) {
      const res = await login(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
  });

  it("allows ten attempts a minute from one address and refuses the eleventh, whatever its credentials", async () => {
    const address = "10.60.0.1";
    for (let i = 1; i <= 10; i++) {
      const res = await login({ username: "admin", password: "wrong" }, address);
      expect(res.statusCode, `attempt ${i}`).toBe(401);
    }
    const eleventh = await login({ username: "admin", password: ADMIN_PASSWORD }, address);
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.headers["set-cookie"]).toBeUndefined();

    // Another address is unaffected.
    expect((await login({ username: "admin", password: ADMIN_PASSWORD }, "10.60.0.2")).statusCode).toBe(200);
  });
});

describe("POST /logout", () => {
  it("answers 200 {ok:true} and clears the cookie, with or without a session", async () => {
    for (const cookie of [h.adminCookie, null]) {
      const res = await h.as(cookie, { method: "POST", url: "/logout" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const cleared = res.cookies.find((c) => c.name === "hydrogen_session");
      expect(cleared).toMatchObject({ value: "", path: "/" });
    }
  });

  it("is stateless: the cookie itself stays valid until it expires", async () => {
    expect((await h.admin({ url: "/me" })).statusCode).toBe(200);
  });
});

describe("GET /me and /setup-info", () => {
  it("/me returns the live user for a session, 401 without one", async () => {
    const res = await h.manager({ url: "/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: 2, username: "mgr", role: "manager", enabled: true, mustChangePassword: false, createdAt: expect.any(Number) } });

    const anon = await h.as(null, { url: "/me" });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: "unauthorized" });
  });

  it("/setup-info is public and discloses nothing", async () => {
    const res = await h.as(null, { url: "/setup-info" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ initial: null });
  });
});

describe("POST /change-password", () => {
  it("needs a session; a short new password is 400; a wrong current password is 400", async () => {
    expect((await h.as(null, { method: "POST", url: "/change-password", payload: { newPassword: "long-enough-new" } })).statusCode).toBe(401);

    const short = await h.manager({ method: "POST", url: "/change-password", payload: { newPassword: "short" } });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toEqual({ error: "newPassword: new password must be at least 8 characters" });

    const wrong = await h.manager({ method: "POST", url: "/change-password", payload: { newPassword: "long-enough-new", currentPassword: "not-it" } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: "current password is incorrect" });
    expect((await login({ username: "mgr", password: MANAGER_PASSWORD })).statusCode).toBe(200);
  });

  it("with the right current password: 200 {user}, a fresh cookie, and the new password works", async () => {
    await h.c.users.create({ username: "changer", password: "changer-pass-old", role: "manager", enabled: true });
    const cookie = await h.login("changer", "changer-pass-old");
    const res = await h.as(cookie, { method: "POST", url: "/change-password", payload: { newPassword: "changer-pass-new", currentPassword: "changer-pass-old" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: "changer", mustChangePassword: false });
    expect(res.cookies.find((c) => c.name === "hydrogen_session")!.value.length).toBeGreaterThan(20);

    expect((await login({ username: "changer", password: "changer-pass-old" })).statusCode).toBe(401);
    expect((await login({ username: "changer", password: "changer-pass-new" })).statusCode).toBe(200);
  });
});

describe("POST /check (public key self-check)", () => {
  const check = (payload: unknown) => h.app.inject({ method: "POST", url: "/admin/api/check", payload: payload as never });
  const setUsage = (id: number, requests: number, tokens: number): void => {
    h.c.sqlite.prepare("UPDATE tokens SET used_requests = ?, used_tokens = ? WHERE id = ?").run(requests, tokens, id);
  };

  it("a healthy key: 200, valid, no flag raised, not cacheable, no session needed", async () => {
    const { secret } = h.c.tokens.create({ name: "healthy", maxRequests: 10, maxTokens: 100 });
    const res = await check({ apiKey: secret });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      key: { name: "healthy", enabled: true, maxRequests: 10, maxTokens: 100, usedRequests: 0, usedTokens: 0, expiresAt: null, createdAt: expect.any(Number), scopeServiceCount: 0 },
      status: { valid: true, expired: false, requestsExceeded: false, tokensExceeded: false, checkedAt: expect.any(Number) },
    });
    expect(res.body).not.toContain(secret);
  });

  it("an expired key is still a 200, reported as expired and not valid", async () => {
    const expiresAt = Date.now() - 60_000;
    const { secret } = h.c.tokens.create({ name: "expired", expiresAt });
    const res = await check({ apiKey: secret });
    expect(res.statusCode).toBe(200);
    expect(res.json().key.expiresAt).toBe(expiresAt);
    expect(res.json().status).toMatchObject({ valid: false, expired: true, requestsExceeded: false, tokensExceeded: false });

    const future = h.c.tokens.create({ name: "not-yet", expiresAt: Date.now() + 3_600_000 });
    expect((await check({ apiKey: future.secret })).json().status).toMatchObject({ valid: true, expired: false });
  });

  it("quotas trip at used == max, one flag each", async () => {
    const t = h.c.tokens.create({ name: "quota", maxRequests: 3, maxTokens: 5 });
    setUsage(t.token.id, 2, 4);
    expect((await check({ apiKey: t.secret })).json().status).toMatchObject({ valid: true, requestsExceeded: false, tokensExceeded: false });

    setUsage(t.token.id, 2, 5);
    expect((await check({ apiKey: t.secret })).json().status).toMatchObject({ valid: false, requestsExceeded: false, tokensExceeded: true });

    setUsage(t.token.id, 3, 4);
    expect((await check({ apiKey: t.secret })).json().status).toMatchObject({ valid: false, requestsExceeded: true, tokensExceeded: false });

    const unlimited = h.c.tokens.create({ name: "unlimited" });
    setUsage(unlimited.token.id, 1_000_000, 1_000_000);
    expect((await check({ apiKey: unlimited.secret })).json().status).toMatchObject({ valid: true, requestsExceeded: false, tokensExceeded: false });
  });

  it("a scoped key reports how many services it may use, never which", async () => {
    const { secret } = h.c.tokens.create({ name: "scoped", scopeServices: [1, 2] });
    const res = await check({ apiKey: secret });
    expect(res.json().key.scopeServiceCount).toBe(2);
    expect(res.json().key).not.toHaveProperty("scopeServices");
    expect(res.json().key).not.toHaveProperty("id");
    expect(res.json().key).not.toHaveProperty("ownerUserId");
  });

  it("a disabled key and an unknown key are the same 401", async () => {
    const { secret } = h.c.tokens.create({ name: "disabled", enabled: false });
    for (const apiKey of [secret, "sk-does-not-exist"]) {
      const res = await check({ apiKey });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid or disabled API key" });
    }
  });

  it("a missing or empty key is 400", async () => {
    const none = await check({});
    expect(none.statusCode).toBe(400);
    expect(none.json()).toEqual({ error: "apiKey: Required" });
    const empty = await check({ apiKey: "" });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: "apiKey: String must contain at least 1 character(s)" });
  });
});
