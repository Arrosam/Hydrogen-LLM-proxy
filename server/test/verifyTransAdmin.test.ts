/**
 * Independent verification (spec section TRANS): T1, T4, T5, T14.
 *
 * Written from the verification spec only. Everything goes through Fastify's
 * inject against the real admin routes; expected values come from the spec.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { ADMIN_PASSWORD, startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;

/** Boot default for the session lifetime, set explicitly so it is not a guess. */
const BOOT_TTL_SECONDS = 2 * 60 * 60;

beforeAll(async () => {
  h = await startAdminHarness("verify-trans-admin", { SESSION_TTL: "2h" });
});

afterAll(async () => {
  delete process.env.SESSION_TTL;
  await h.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const errorOf = (res: { json: () => unknown }): unknown => (res.json() as { error?: unknown }).error;

// ---------------------------------------------------------------------------
// T1 — upstream allowlist entry grammar
// ---------------------------------------------------------------------------

describe("T1: PUT /settings/upstream-allowlist", () => {
  const put = (entries: unknown) => h.admin({ method: "PUT", url: "/settings/upstream-allowlist", payload: { entries } });
  const stored = async (): Promise<string[]> => ((await h.admin({ url: "/settings/upstream-allowlist" })).json() as { entries: string[] }).entries;

  const MALFORMED = ["10.0.0.0/", "10.0.0.0/8/9", "10.0.0.0/ 8", "10.0.0.0/0x8", "10.0.0.0/33", "10.0.0.0/08"];

  it.each(MALFORMED)("rejects the malformed CIDR %j with 400 and stores nothing", async (bad) => {
    const baseline = await put(["keep.example.com"]);
    expect(baseline.statusCode).toBe(200);

    const alone = await put([bad]);
    expect(alone.statusCode).toBe(400);
    expect(typeof errorOf(alone)).toBe("string");

    // Mixed with a good entry the whole save is still refused.
    const mixed = await put(["10.0.0.0/8", bad]);
    expect(mixed.statusCode).toBe(400);

    expect(await stored()).toEqual(["keep.example.com"]);
  });

  it("accepts the well-formed 10.0.0.0/8", async () => {
    const res = await put(["10.0.0.0/8"]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: ["10.0.0.0/8"] });
    expect(await stored()).toEqual(["10.0.0.0/8"]);
  });

  it("accepts an explicit 0.0.0.0/0", async () => {
    const res = await put(["0.0.0.0/0"]);
    expect(res.statusCode).toBe(200);
    expect(await stored()).toEqual(["0.0.0.0/0"]);
  });

  it("prefix boundaries: /0 and /32 accepted, /33 rejected", async () => {
    expect((await put(["10.0.0.0/0"])).statusCode).toBe(200);
    expect((await put(["10.1.2.3/32"])).statusCode).toBe(200);
    expect((await put(["10.1.2.3/33"])).statusCode).toBe(400);
  });

  it("unchanged neighbours: a plain IP, a hostname and a domain suffix are still accepted", async () => {
    const entries = ["192.168.1.1", "api.example.com", ".example.com"];
    const res = await put(entries);
    expect(res.statusCode).toBe(200);
    expect(await stored()).toEqual(entries);
  });
});

// ---------------------------------------------------------------------------
// T4 — runtime session TTL applies to the next login
// ---------------------------------------------------------------------------

describe("T4: session lifetime follows the runtime sessionTtlMs", () => {
  let ip = 0;

  /** A fresh login, reporting the cookie's Max-Age and the token's own lifetime (seconds). */
  async function loginLifetime(): Promise<{ maxAge: number | undefined; tokenSeconds: number; cookie: string }> {
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { username: "admin", password: ADMIN_PASSWORD },
      remoteAddress: `10.77.0.${(ip++ % 250) + 1}`,
    });
    expect(res.statusCode).toBe(200);
    const session = res.cookies.find((k) => k.name === "hydrogen_session");
    expect(session).toBeDefined();
    const claims = jwt.decode(session!.value) as { iat: number; exp: number };
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    return { maxAge: session!.maxAge, tokenSeconds: claims.exp - claims.iat, cookie: `${session!.name}=${session!.value}` };
  }

  const setTtl = (sessionTtlMs: number) => h.admin({ method: "PUT", url: "/settings/env", payload: { sessionTtlMs } });

  it("with no runtime value set, the boot default applies", async () => {
    const got = await loginLifetime();
    expect(got.maxAge).toBe(BOOT_TTL_SECONDS);
    expect(got.tokenSeconds).toBe(BOOT_TTL_SECONDS);
  });

  it("after PUT sessionTtlMs, the next login's cookie and token carry the new lifetime", async () => {
    expect((await setTtl(120_000)).statusCode).toBe(200);
    const short = await loginLifetime();
    expect(short.maxAge).toBe(120);
    expect(short.tokenSeconds).toBe(120);

    // The new session is a working one.
    expect((await h.as(short.cookie, { url: "/settings/env" })).statusCode).toBe(200);
  });

  it("each later change applies to the login after it (lower bound 60 s, a longer one, the 30-day upper bound)", async () => {
    for (const ms of [60_000, 3_600_000, 30 * 86_400_000]) {
      expect((await setTtl(ms)).statusCode).toBe(200);
      const got = await loginLifetime();
      expect(got.maxAge, `Max-Age for ${ms}`).toBe(ms / 1000);
      expect(got.tokenSeconds, `token lifetime for ${ms}`).toBe(ms / 1000);
    }
  });

  it("a rejected TTL change leaves the lifetime of the next login where it was", async () => {
    expect((await setTtl(300_000)).statusCode).toBe(200);
    expect((await setTtl(59_999)).statusCode).toBe(400);
    const got = await loginLifetime();
    expect(got.maxAge).toBe(300);
    expect(got.tokenSeconds).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// T5 — provider base URLs are validated, never a 500
// ---------------------------------------------------------------------------

describe("T5: provider baseUrl / altEndpoints[].baseUrl validation", () => {
  const BASE = { name: "t5", type: "openai_completion", baseUrl: "http://provider.invalid/v1" };
  const create = (payload: unknown) => h.admin({ method: "POST", url: "/providers", payload });
  const patch = (id: number, payload: unknown) => h.admin({ method: "PATCH", url: `/providers/${id}`, payload });
  const test = (payload: unknown) => h.admin({ method: "POST", url: "/providers/test", payload });
  const names = async (): Promise<string[]> =>
    ((await h.admin({ url: "/providers" })).json() as { providers: Array<{ name: string }> }).providers.map((p) => p.name);

  /** 400 with a validation message — a non-empty string, not a 500 envelope. */
  const expectValidation400 = (res: { statusCode: number; json: () => unknown }, label: string): void => {
    expect(res.statusCode, label).toBe(400);
    const error = errorOf(res);
    expect(typeof error, label).toBe("string");
    expect((error as string).length, label).toBeGreaterThan(0);
  };

  let existingId = 0;
  beforeAll(async () => {
    const res = await create({ ...BASE, name: "t5-existing" });
    expect(res.statusCode).toBe(201);
    existingId = (res.json() as { provider: { id: number } }).provider.id;
  });

  const BAD_URLS = ["nope", "ftp://x"];

  it.each(BAD_URLS)("POST /providers with baseUrl %j → 400, nothing created", async (baseUrl) => {
    const res = await create({ ...BASE, name: "t5-bad-create", baseUrl });
    expectValidation400(res, baseUrl);
    expect(errorOf(res)).toContain("baseUrl");
    expect(await names()).not.toContain("t5-bad-create");
  });

  it.each(BAD_URLS)("PATCH /providers/:id with baseUrl %j → 400, row unchanged", async (baseUrl) => {
    const res = await patch(existingId, { baseUrl });
    expectValidation400(res, baseUrl);
    expect(errorOf(res)).toContain("baseUrl");
    const row = ((await h.admin({ url: "/providers" })).json() as { providers: Array<{ id: number; baseUrl: string }> }).providers.find((p) => p.id === existingId);
    expect(row?.baseUrl).toBe(BASE.baseUrl);
  });

  it.each(BAD_URLS)("POST /providers/test with baseUrl %j → 400, and nothing is sent upstream", async (baseUrl) => {
    const getJson = vi.spyOn(h.c.transport, "getJson").mockResolvedValue({ status: 200, json: { data: [] }, text: "" } as never);
    const res = await test({ type: "openai_completion", baseUrl, apiKey: "k" });
    expectValidation400(res, baseUrl);
    expect(errorOf(res)).toContain("baseUrl");
    expect(getJson).not.toHaveBeenCalled();
  });

  it.each(BAD_URLS)("POST /providers with altEndpoints[].baseUrl %j → 400, nothing created", async (baseUrl) => {
    const res = await create({ ...BASE, name: "t5-bad-alt", altEndpoints: [{ type: "anthropic", baseUrl }] });
    expectValidation400(res, baseUrl);
    expect(await names()).not.toContain("t5-bad-alt");
  });

  it.each(BAD_URLS)("PATCH /providers/:id with altEndpoints[].baseUrl %j → 400, row unchanged", async (baseUrl) => {
    const res = await patch(existingId, { altEndpoints: [{ type: "anthropic", baseUrl }] });
    expectValidation400(res, baseUrl);
    const row = ((await h.admin({ url: "/providers" })).json() as { providers: Array<{ id: number; altEndpoints: unknown }> }).providers.find((p) => p.id === existingId);
    expect(row?.altEndpoints).toBeNull();
  });

  it("a bad alternate after a good one is still refused (second position)", async () => {
    const res = await create({
      ...BASE,
      name: "t5-bad-alt-2",
      altEndpoints: [{ type: "anthropic", baseUrl: "http://alt.invalid" }, { type: "openai_responses", baseUrl: "nope" }],
    });
    expectValidation400(res, "second alt");
    expect(await names()).not.toContain("t5-bad-alt-2");
  });

  it("unchanged: valid http and https URLs still succeed on create, patch and test", async () => {
    const http = await create({ ...BASE, name: "t5-http" });
    expect(http.statusCode).toBe(201);
    const https = await create({ ...BASE, name: "t5-https", baseUrl: "https://provider.invalid/v1", altEndpoints: [{ type: "anthropic", baseUrl: "https://alt.invalid" }] });
    expect(https.statusCode).toBe(201);
    expect((https.json() as { provider: { altEndpoints: unknown[] } }).provider.altEndpoints).toHaveLength(1);

    const patched = await patch(existingId, { baseUrl: "https://moved.invalid/v1", altEndpoints: [{ type: "anthropic", baseUrl: "http://alt.invalid" }] });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { provider: { baseUrl: string } }).provider.baseUrl).toBe("https://moved.invalid/v1");
    // Restore for the cases that read the row.
    expect((await patch(existingId, { baseUrl: BASE.baseUrl, altEndpoints: null })).statusCode).toBe(200);

    vi.spyOn(h.c.transport, "getJson").mockResolvedValue({ status: 200, json: { data: [{ id: "m1" }] }, text: "" } as never);
    for (const baseUrl of ["http://form.invalid/v1", "https://form.invalid/v1"]) {
      const res = await test({ type: "openai_completion", baseUrl, apiKey: "k" });
      expect(res.statusCode, baseUrl).toBe(200);
      expect((res.json() as { ok: boolean }).ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// T14 — PATCH /users/:id enforces the same password minimum as POST /users
// ---------------------------------------------------------------------------

describe("T14: short password on PATCH /users/:id", () => {
  let userId = 0;
  const ORIGINAL = "original-pass-1";

  beforeAll(async () => {
    const res = await h.admin({ method: "POST", url: "/users", payload: { username: "t14-user", password: ORIGINAL } });
    expect(res.statusCode).toBe(201);
    userId = (res.json() as { user: { id: number } }).user.id;
  });

  it.each(["1234567", "short", "a"])("password %j → 400 with POST's message for the same password", async (password) => {
    const viaPost = await h.admin({ method: "POST", url: "/users", payload: { username: `t14-new-${password.length}`, password } });
    expect(viaPost.statusCode).toBe(400);
    const postMessage = errorOf(viaPost);
    expect(typeof postMessage).toBe("string");

    const viaPatch = await h.admin({ method: "PATCH", url: `/users/${userId}`, payload: { password } });
    expect(viaPatch.statusCode).toBe(400);
    expect(errorOf(viaPatch)).toBe(postMessage);
  });

  it("a refused short password leaves the old password working", async () => {
    await h.admin({ method: "PATCH", url: `/users/${userId}`, payload: { password: "1234567" } });
    await expect(h.login("t14-user", ORIGINAL)).resolves.toContain("hydrogen_session=");
    await expect(h.login("t14-user", "1234567")).rejects.toThrow();
  });

  it("boundary: exactly 8 characters is accepted and becomes the login password", async () => {
    const res = await h.admin({ method: "PATCH", url: `/users/${userId}`, payload: { password: "12345678" } });
    expect(res.statusCode).toBe(200);
    await expect(h.login("t14-user", "12345678")).resolves.toContain("hydrogen_session=");
  });

  it("unchanged: a patch that does not touch the password is not subject to the rule", async () => {
    const res = await h.admin({ method: "PATCH", url: `/users/${userId}`, payload: { enabled: true } });
    expect(res.statusCode).toBe(200);
  });
});
