/**
 * Characterization of the user and API-key admin routes: the last-admin and
 * self-protection rules, the token body boundaries, and every status code and
 * JSON body as an admin and as a manager. Also the session side of account
 * state: a disabled or deleted user's existing cookie stops working at once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;

beforeAll(async () => {
  h = await startAdminHarness("cov-users");
});

afterAll(async () => {
  await h.close();
});

const PASSWORD = "another-pass-123";
const USER_KEYS = ["createdAt", "enabled", "id", "mustChangePassword", "role", "username"];
const TOKEN_KEYS = [
  "createdAt", "enabled", "expiresAt", "hasStoredKey", "id", "keyPrefix", "maxRequests", "maxTokens", "name", "ownerUserId", "scopeServices", "usedRequests", "usedTokens",
];

describe("users", () => {
  it("GET lists public rows (no password hash)", async () => {
    const res = await h.admin({ url: "/users" });
    expect(res.statusCode).toBe(200);
    const { users } = res.json();
    expect(users.map((u: { username: string }) => u.username)).toEqual(["admin", "mgr"]);
    for (const u of users) expect(Object.keys(u).sort()).toEqual(USER_KEYS);
    expect(users[0]).toEqual({ id: 1, username: "admin", role: "admin", enabled: true, mustChangePassword: false, createdAt: expect.any(Number) });
  });

  it("POST creates with 201; role defaults to manager", async () => {
    const res = await h.admin({ method: "POST", url: "/users", payload: { username: "plain", password: PASSWORD } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      user: { id: expect.any(Number), username: "plain", role: "manager", enabled: true, mustChangePassword: false, createdAt: expect.any(Number) },
    });
    expect(res.body).not.toContain(PASSWORD);
  });

  it("POST: an existing username is 409 with its own message (not the constraint mapper's)", async () => {
    const res = await h.admin({ method: "POST", url: "/users", payload: { username: "mgr", password: PASSWORD } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "username already exists" });
  });

  it("POST rejects an invalid body with 400 and a `path: message` error", async () => {
    const cases: Array<[unknown, string]> = [
      [{ username: "x", password: "short" }, "password: password must be at least 8 characters"],
      [{ username: "x", password: "1234567" }, "password: password must be at least 8 characters"],
      [{ username: "", password: PASSWORD }, "username: String must contain at least 1 character(s)"],
      [{ username: "u".repeat(65), password: PASSWORD }, "username: String must contain at most 64 character(s)"],
      [{ username: "x", password: PASSWORD, role: "root" }, "role: Invalid enum value. Expected 'admin' | 'manager', received 'root'"],
      [{}, "username: Required; password: Required"],
    ];
    for (const [payload, error] of cases) {
      const res = await h.admin({ method: "POST", url: "/users", payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
    // Exactly 8 characters is enough.
    expect((await h.admin({ method: "POST", url: "/users", payload: { username: "eight", password: "12345678" } })).statusCode).toBe(201);
  });

  it("PATCH: invalid id 400, unknown id 404, invalid body 400", async () => {
    const bad = await h.admin({ method: "PATCH", url: "/users/abc", payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "PATCH", url: "/users/9999", payload: { role: "root" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const body = await h.admin({ method: "PATCH", url: "/users/2", payload: { role: "root" } });
    expect(body.statusCode).toBe(400);
    expect(body.json()).toEqual({ error: "role: Invalid enum value. Expected 'admin' | 'manager', received 'root'" });

    const pw = await h.admin({ method: "PATCH", url: "/users/2", payload: { password: "short" } });
    expect(pw.statusCode).toBe(400);
    expect(pw.json()).toEqual({ error: "password: password must be at least 8 characters" });
  });

  it("PATCH with an empty body returns the user unchanged", async () => {
    const res = await h.admin({ method: "PATCH", url: "/users/2", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: 2, username: "mgr", role: "manager", enabled: true, mustChangePassword: false, createdAt: expect.any(Number) } });
  });

  it("DELETE: invalid id 400, unknown id 404, success 200 {ok:true}", async () => {
    const bad = await h.admin({ method: "DELETE", url: "/users/abc" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "DELETE", url: "/users/9999" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const id = (await h.admin({ method: "POST", url: "/users", payload: { username: "doomed", password: PASSWORD } })).json().user.id;
    const ok = await h.admin({ method: "DELETE", url: `/users/${id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(h.c.users.get(id)).toBeUndefined();
  });

  it("a manager is refused everything, the gate coming before id validation", async () => {
    const cases: Array<[Parameters<AdminHarness["manager"]>[0], string]> = [
      [{ url: "/users" }, "only an admin can view users"],
      [{ method: "POST", url: "/users", payload: {} }, "only an admin can create users"],
      [{ method: "PATCH", url: "/users/abc", payload: {} }, "only an admin can modify users"],
      [{ method: "DELETE", url: "/users/abc" }, "only an admin can delete users"],
    ];
    for (const [call, error] of cases) {
      const res = await h.manager(call);
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect(res.json()).toEqual({ error });
    }
  });
});

describe("last-admin and self-protection rules (the caller is user 1, the only admin)", () => {
  it("cannot deactivate, demote or delete itself while it is the last admin", async () => {
    const off = await h.admin({ method: "PATCH", url: "/users/1", payload: { enabled: false } });
    expect(off.statusCode).toBe(400);
    expect(off.json()).toEqual({ error: "you cannot deactivate your own account" });

    const demote = await h.admin({ method: "PATCH", url: "/users/1", payload: { role: "manager" } });
    expect(demote.statusCode).toBe(400);
    expect(demote.json()).toEqual({ error: "cannot deactivate or demote the last admin" });

    const del = await h.admin({ method: "DELETE", url: "/users/1" });
    expect(del.statusCode).toBe(400);
    expect(del.json()).toEqual({ error: "cannot delete the last admin" });

    expect(h.c.users.get(1)).toMatchObject({ role: "admin", enabled: true });
  });

  it("with a second admin: still cannot delete itself, but the other admin can be demoted", async () => {
    const a2 = (await h.admin({ method: "POST", url: "/users", payload: { username: "a2", password: PASSWORD, role: "admin" } })).json().user.id;

    const self = await h.admin({ method: "DELETE", url: "/users/1" });
    expect(self.statusCode).toBe(400);
    expect(self.json()).toEqual({ error: "cannot delete your own account" });

    const demoted = await h.admin({ method: "PATCH", url: `/users/${a2}`, payload: { role: "manager" } });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json().user).toMatchObject({ id: a2, role: "manager" });
    await h.admin({ method: "PATCH", url: `/users/${a2}`, payload: { role: "admin" } });
  });

  it("PATCH counts ENABLED admins, DELETE counts all admins", async () => {
    const a2 = h.c.users.getByUsername("a2")!.id;
    const disabled = await h.admin({ method: "PATCH", url: `/users/${a2}`, payload: { enabled: false } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().user).toMatchObject({ id: a2, role: "admin", enabled: false });

    // One enabled admin left (the caller): it cannot demote itself...
    const demote = await h.admin({ method: "PATCH", url: "/users/1", payload: { role: "manager" } });
    expect(demote.statusCode).toBe(400);
    expect(demote.json()).toEqual({ error: "cannot deactivate or demote the last admin" });

    // ...yet the disabled admin still counts for DELETE, so removing it is allowed.
    const del = await h.admin({ method: "DELETE", url: `/users/${a2}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
  });
});

describe("account state and existing sessions", () => {
  it("a disabled user's cookie is rejected at once, and works again when re-enabled", async () => {
    const id = (await h.admin({ method: "POST", url: "/users", payload: { username: "toggle", password: PASSWORD } })).json().user.id;
    const cookie = await h.login("toggle", PASSWORD);
    expect((await h.as(cookie, { url: "/tokens" })).statusCode).toBe(200);

    expect((await h.admin({ method: "PATCH", url: `/users/${id}`, payload: { enabled: false } })).statusCode).toBe(200);
    const refused = await h.as(cookie, { url: "/tokens" });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({ error: "unauthorized" });
    expect((await h.as(cookie, { url: "/me" })).statusCode).toBe(401);

    await h.admin({ method: "PATCH", url: `/users/${id}`, payload: { enabled: true } });
    expect((await h.as(cookie, { url: "/tokens" })).statusCode).toBe(200);
  });

  it("a deleted user's cookie is rejected", async () => {
    const id = (await h.admin({ method: "POST", url: "/users", payload: { username: "gone", password: PASSWORD } })).json().user.id;
    const cookie = await h.login("gone", PASSWORD);
    await h.admin({ method: "DELETE", url: `/users/${id}` });
    expect((await h.as(cookie, { url: "/tokens" })).statusCode).toBe(401);
  });

  it("a role change applies to the existing cookie (the role is read from the database, not the cookie)", async () => {
    const id = (await h.admin({ method: "POST", url: "/users", payload: { username: "riser", password: PASSWORD } })).json().user.id;
    const cookie = await h.login("riser", PASSWORD);
    expect((await h.as(cookie, { url: "/users" })).statusCode).toBe(403);
    await h.admin({ method: "PATCH", url: `/users/${id}`, payload: { role: "admin" } });
    expect((await h.as(cookie, { url: "/users" })).statusCode).toBe(200);
    await h.admin({ method: "PATCH", url: `/users/${id}`, payload: { role: "manager" } });
    expect((await h.as(cookie, { url: "/users" })).statusCode).toBe(403);
  });

  it("no cookie, a garbage cookie and a tampered cookie are all 401 unauthorized", async () => {
    for (const cookie of [null, "hydrogen_session=garbage", `${h.adminCookie}x`]) {
      const res = await h.as(cookie, { url: "/tokens" });
      expect(res.statusCode, String(cookie).slice(0, 30)).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("a new password set by an admin works for the next login and the old one does not", async () => {
    const id = (await h.admin({ method: "POST", url: "/users", payload: { username: "rekey", password: PASSWORD } })).json().user.id;
    expect((await h.admin({ method: "PATCH", url: `/users/${id}`, payload: { password: "brand-new-pass-1" } })).statusCode).toBe(200);
    await expect(h.login("rekey", PASSWORD)).rejects.toThrow(/401/);
    await expect(h.login("rekey", "brand-new-pass-1")).resolves.toMatch(/^hydrogen_session=/);
  });
});

describe("tokens", () => {
  let tokenId: number;
  let secret: string;

  it("POST issues with 201: the public row plus the secret, owned by the caller", async () => {
    const res = await h.admin({ method: "POST", url: "/tokens", payload: { name: "k" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["secret", "token"]);
    expect(body.secret).toMatch(/^sk-/);
    expect(body.token).toEqual({
      id: expect.any(Number),
      name: "k",
      keyPrefix: body.secret.slice(0, body.token.keyPrefix.length),
      ownerUserId: 1,
      scopeServices: null,
      maxRequests: null,
      maxTokens: null,
      usedRequests: 0,
      usedTokens: 0,
      expiresAt: null,
      enabled: true,
      createdAt: expect.any(Number),
      hasStoredKey: true,
    });
    tokenId = body.token.id;
    secret = body.secret;
    expect(h.c.tokens.authenticate(secret)?.id).toBe(tokenId);
  });

  it("POST accepts every optional field, and null for each nullable one", async () => {
    const expiresAt = Date.now() + 86_400_000;
    const full = await h.admin({ method: "POST", url: "/tokens", payload: { name: "full", scopeServices: [1, 2], maxRequests: 1, maxTokens: 1, expiresAt, enabled: false } });
    expect(full.statusCode).toBe(201);
    expect(full.json().token).toMatchObject({ scopeServices: [1, 2], maxRequests: 1, maxTokens: 1, expiresAt, enabled: false });

    const nulls = await h.admin({ method: "POST", url: "/tokens", payload: { name: "nulls", scopeServices: null, maxRequests: null, maxTokens: null, expiresAt: null } });
    expect(nulls.statusCode).toBe(201);
    expect(nulls.json().token).toMatchObject({ scopeServices: null, maxRequests: null, maxTokens: null, expiresAt: null });
  });

  it("POST rejects an invalid body with 400 and a `path: message` error", async () => {
    const cases: Array<[unknown, string]> = [
      [{}, "name: Required"],
      [{ name: "" }, "name: String must contain at least 1 character(s)"],
      [{ name: "n".repeat(121) }, "name: String must contain at most 120 character(s)"],
      [{ name: "k", maxRequests: 0 }, "maxRequests: Number must be greater than 0"],
      [{ name: "k", maxRequests: -1 }, "maxRequests: Number must be greater than 0"],
      [{ name: "k", maxRequests: 1.5 }, "maxRequests: Expected integer, received float"],
      [{ name: "k", maxTokens: 0 }, "maxTokens: Number must be greater than 0"],
      [{ name: "k", expiresAt: 0 }, "expiresAt: Number must be greater than 0"],
      [{ name: "k", scopeServices: [0] }, "scopeServices.0: Number must be greater than 0"],
      [{ name: "k", scopeServices: "1" }, "scopeServices: Expected array, received string"],
    ];
    for (const [payload, error] of cases) {
      const res = await h.admin({ method: "POST", url: "/tokens", payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
    expect((await h.admin({ method: "POST", url: "/tokens", payload: { name: "n".repeat(120) } })).statusCode).toBe(201);
  });

  it("GET lists public rows to any dashboard user: no secret, no hash", async () => {
    for (const who of [h.admin, h.manager]) {
      const res = await who({ url: "/tokens" });
      expect(res.statusCode).toBe(200);
      const { tokens } = res.json();
      for (const t of tokens) expect(Object.keys(t).sort()).toEqual([...TOKEN_KEYS].sort());
      expect(res.body).not.toContain(secret);
    }
  });

  it("PATCH sets and clears a quota; an empty patch returns the row unchanged", async () => {
    const set = await h.admin({ method: "PATCH", url: `/tokens/${tokenId}`, payload: { maxRequests: 5, name: "renamed" } });
    expect(set.statusCode).toBe(200);
    expect(set.json().token).toMatchObject({ id: tokenId, name: "renamed", maxRequests: 5 });
    expect(set.json()).not.toHaveProperty("secret");

    const noop = await h.admin({ method: "PATCH", url: `/tokens/${tokenId}`, payload: {} });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().token).toMatchObject({ id: tokenId, name: "renamed", maxRequests: 5 });

    const cleared = await h.admin({ method: "PATCH", url: `/tokens/${tokenId}`, payload: { maxRequests: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().token.maxRequests).toBeNull();
  });

  it("PATCH: invalid id 400, unknown id 404, invalid body 400 (existence is checked before the body)", async () => {
    const bad = await h.admin({ method: "PATCH", url: "/tokens/abc", payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "PATCH", url: "/tokens/99999", payload: { maxRequests: 0 } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const body = await h.admin({ method: "PATCH", url: `/tokens/${tokenId}`, payload: { maxRequests: 0 } });
    expect(body.statusCode).toBe(400);
    expect(body.json()).toEqual({ error: "maxRequests: Number must be greater than 0" });
  });

  it("POST /:id/secret reveals the issued key; invalid id 400, unknown id 404", async () => {
    const ok = await h.admin({ method: "POST", url: `/tokens/${tokenId}/secret` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ secret });

    const bad = await h.admin({ method: "POST", url: "/tokens/abc/secret" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "POST", url: "/tokens/99999/secret" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });
  });

  it("POST /:id/secret on a key with no stored ciphertext is 409", async () => {
    const legacy = (await h.admin({ method: "POST", url: "/tokens", payload: { name: "legacy" } })).json().token.id;
    h.c.sqlite.prepare("UPDATE tokens SET key_ciphertext = NULL, key_iv = NULL, key_tag = NULL WHERE id = ?").run(legacy);

    const res = await h.admin({ method: "POST", url: `/tokens/${legacy}/secret` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "key issued before stored keys; revoke and reissue to make it copyable" });
    expect((await h.admin({ url: "/tokens" })).json().tokens.find((t: { id: number }) => t.id === legacy).hasStoredKey).toBe(false);
  });

  it("DELETE: invalid id 400, unknown id 404, success 200 {ok:true} and the key stops authenticating", async () => {
    const bad = await h.admin({ method: "DELETE", url: "/tokens/abc" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "DELETE", url: "/tokens/99999" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const ok = await h.admin({ method: "DELETE", url: `/tokens/${tokenId}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(h.c.tokens.authenticate(secret)).toBeUndefined();
  });

  it("a manager is refused every write and the reveal, the gate coming before id validation", async () => {
    const cases: Array<[Parameters<AdminHarness["manager"]>[0], string]> = [
      [{ method: "POST", url: "/tokens", payload: { name: "m" } }, "only an admin can issue API keys"],
      [{ method: "POST", url: "/tokens/abc/secret" }, "only an admin can reveal API keys"],
      [{ method: "PATCH", url: "/tokens/abc", payload: {} }, "only an admin can modify API keys"],
      [{ method: "DELETE", url: "/tokens/abc" }, "only an admin can delete API keys"],
    ];
    for (const [call, error] of cases) {
      const res = await h.manager(call);
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect(res.json()).toEqual({ error });
    }
    expect(h.c.tokens.list().some((t) => t.name === "m")).toBe(false);
  });
});
