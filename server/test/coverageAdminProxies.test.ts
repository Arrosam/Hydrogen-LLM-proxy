/**
 * The admin egress-proxy routes (/admin/api/proxies), the repo behind them and
 * the password sealing: CRUD, the "never return the password" rule, when a
 * cached connection pool is retired, the in-use delete refusal, and the probe.
 *
 * Also a characterization: status codes and bodies are pinned exactly, because
 * this file's routes do not match the other admin files (create answers 200,
 * not 201) and that has to survive a move onto shared scaffolding.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;

beforeAll(async () => {
  h = await startAdminHarness("cov-proxies");
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const create = (payload: unknown) => h.admin({ method: "POST", url: "/proxies", payload });
const rawRow = (id: number) => h.c.sqlite.prepare("SELECT * FROM proxies WHERE id = ?").get(id) as Record<string, unknown>;

describe("create", () => {
  it("answers 200 (not 201 -- differs from every other admin create) with the public row, never the password", async () => {
    const res = await create({ name: "px", host: "proxy.local", port: 8080, username: "u", password: "secret" });
    expect(res.statusCode).toBe(200);
    const { proxy } = res.json();
    expect(proxy).toEqual({
      id: expect.any(Number),
      name: "px",
      scheme: "http",
      host: "proxy.local",
      port: 8080,
      username: "u",
      hasPassword: true,
      enabled: true,
      createdAt: expect.any(Number),
    });
    expect(res.body).not.toContain("secret");

    // At rest the password is sealed, and only toEgress opens it.
    const row = rawRow(proxy.id);
    expect(JSON.stringify(row, (_k, v) => (Buffer.isBuffer(v) ? v.toString("latin1") : v))).not.toContain("secret");
    expect(h.c.proxies.toEgress(h.c.proxies.get(proxy.id)!)).toEqual({
      id: proxy.id,
      name: "px",
      scheme: "http",
      host: "proxy.local",
      port: 8080,
      username: "u",
      password: "secret",
    });
  });

  it("a proxy with no credentials reports hasPassword:false and username null", async () => {
    const res = await create({ name: "bare", scheme: "https", host: "10.1.2.3", port: 3128, enabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().proxy).toMatchObject({ name: "bare", scheme: "https", username: null, hasPassword: false, enabled: false });
    expect(h.c.proxies.toEgress(h.c.proxies.getByName("bare")!).password).toBeNull();
  });

  it("an empty-string password is stored as no password", async () => {
    const res = await create({ name: "blank-pw", host: "h.local", port: 8080, password: "" });
    expect(res.statusCode).toBe(200);
    expect(res.json().proxy.hasPassword).toBe(false);
  });

  it("the same name again is 409, naming the proxy", async () => {
    const res = await create({ name: "px", host: "other.local", port: 9090 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'a proxy named "px" already exists' });
  });

  it("port boundaries: 0 and 65536 rejected, 1 and 65535 accepted", async () => {
    const low = await create({ name: "p0", host: "h", port: 0 });
    expect(low.statusCode).toBe(400);
    expect(low.json()).toEqual({ error: "port: Number must be greater than or equal to 1" });
    const high = await create({ name: "p65536", host: "h", port: 65536 });
    expect(high.statusCode).toBe(400);
    expect(high.json()).toEqual({ error: "port: Number must be less than or equal to 65535" });
    expect((await create({ name: "p1", host: "h", port: 1 })).statusCode).toBe(200);
    expect((await create({ name: "p65535", host: "h", port: 65535 })).statusCode).toBe(200);
    expect((await create({ name: "pfloat", host: "h", port: 80.5 })).statusCode).toBe(400);
  });

  it("host grammar: a hostname or anything containing a colon; scheme is http or https only", async () => {
    const bad = await create({ name: "bad-host", host: "bad host", port: 8080 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "host: host must be a hostname or an IP address" });
    expect((await create({ name: "v6", host: "::1", port: 8080 })).statusCode).toBe(200);

    const scheme = await create({ name: "socks", host: "h", port: 8080, scheme: "socks5" });
    expect(scheme.statusCode).toBe(400);
    expect(scheme.json()).toEqual({ error: "scheme: Invalid enum value. Expected 'http' | 'https', received 'socks5'" });
  });

  it("an empty body lists every missing field as `path: message` joined by '; '", async () => {
    const res = await create({});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "name: Required; host: Required; port: Required" });
  });
});

describe("list", () => {
  it("returns public rows and is readable by a manager (the provider editor needs it)", async () => {
    const res = await h.manager({ url: "/proxies" });
    expect(res.statusCode).toBe(200);
    const { proxies } = res.json();
    expect(proxies.find((p: { name: string }) => p.name === "px")).toMatchObject({ hasPassword: true });
    for (const p of proxies) expect(Object.keys(p).sort()).toEqual(["createdAt", "enabled", "hasPassword", "host", "id", "name", "port", "scheme", "username"]);
    expect(res.body).not.toContain("secret");
  });
});

describe("update", () => {
  let id: number;
  beforeAll(async () => {
    id = (await create({ name: "edit-me", host: "edit.local", port: 8080, username: "u", password: "pw-1" })).json().proxy.id;
  });

  it("an empty patch returns the row unchanged", async () => {
    const res = await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().proxy).toMatchObject({ id, name: "edit-me", host: "edit.local", port: 8080, username: "u", hasPassword: true, enabled: true });
  });

  it("renaming or toggling enabled does NOT retire the cached pool", async () => {
    const forget = vi.spyOn(h.c.egressPool, "forgetProxy");
    expect((await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { name: "renamed" } })).json().proxy.name).toBe("renamed");
    expect((await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { enabled: false } })).json().proxy.enabled).toBe(false);
    expect((await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { enabled: true } })).statusCode).toBe(200);
    expect(forget).not.toHaveBeenCalled();
  });

  it("changing a connection field retires the pool built from the PRE-edit proxy, once", async () => {
    const forget = vi.spyOn(h.c.egressPool, "forgetProxy");
    const res = await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { port: 9090 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().proxy.port).toBe(9090);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget.mock.calls[0][0]).toMatchObject({ id, port: 8080, password: "pw-1" });

    forget.mockClear();
    expect((await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { password: "pw-2" } })).statusCode).toBe(200);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget.mock.calls[0][0]).toMatchObject({ id, port: 9090, password: "pw-1" });
    expect(h.c.proxies.toEgress(h.c.proxies.get(id)!).password).toBe("pw-2");

    // The same password again changes nothing a connection depends on.
    forget.mockClear();
    expect((await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { password: "pw-2" } })).statusCode).toBe(200);
    expect(forget).not.toHaveBeenCalled();
  });

  it('password "" and null both clear it; omitting it leaves it alone', async () => {
    const empty = await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { password: "" } });
    expect(empty.json().proxy.hasPassword).toBe(false);
    expect(h.c.proxies.toEgress(h.c.proxies.get(id)!).password).toBeNull();

    await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { password: "pw-3" } });
    const kept = await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { username: "u2" } });
    expect(kept.json().proxy).toMatchObject({ username: "u2", hasPassword: true });

    const nulled = await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { password: null } });
    expect(nulled.json().proxy.hasPassword).toBe(false);
    const clearedUser = await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { username: null } });
    expect(clearedUser.json().proxy.username).toBeNull();
  });

  it("invalid id 400, unknown id 404, invalid body 400 (existence is checked before the body)", async () => {
    const bad = await h.admin({ method: "PATCH", url: "/proxies/abc", payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "PATCH", url: "/proxies/99999", payload: { port: "x" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const body = await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: { port: "x" } });
    expect(body.statusCode).toBe(400);
    expect(body.json()).toEqual({ error: "port: Expected number, received string" });
  });
});

describe("a provider attached to a proxy", () => {
  it("materializes with the decrypted proxy, and the proxy cannot be deleted while attached", async () => {
    const proxyId = (await create({ name: "attached", host: "egress.local", port: 3128, username: "svc", password: "p@ss" })).json().proxy.id;
    const provider = h.c.providers.create({ name: "via-proxy", type: "openai_completion", baseUrl: "http://provider.invalid/v1", apiKey: "k", proxyId });

    expect(h.c.providers.toUpstream(h.c.providers.get(provider.id)!).proxy).toEqual({
      id: proxyId,
      name: "attached",
      scheme: "http",
      host: "egress.local",
      port: 3128,
      username: "svc",
      password: "p@ss",
    });
    expect(h.c.proxies.usedBy(proxyId)).toEqual([{ id: provider.id, name: "via-proxy" }]);

    const forget = vi.spyOn(h.c.egressPool, "forgetProxy");
    const refused = await h.admin({ method: "DELETE", url: `/proxies/${proxyId}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: 'proxy "attached" is still used by 1 provider(s): via-proxy. Detach it there first.',
      providers: [{ id: provider.id, name: "via-proxy" }],
    });
    expect(h.c.proxies.get(proxyId)).toBeTruthy();
    expect(forget).not.toHaveBeenCalled();

    h.c.providers.update(provider.id, { proxyId: null });
    const ok = await h.admin({ method: "DELETE", url: `/proxies/${proxyId}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(h.c.proxies.get(proxyId)).toBeUndefined();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget.mock.calls[0][0]).toMatchObject({ id: proxyId, password: "p@ss" });
  });

  it("a provider with no proxy materializes with proxy null", () => {
    const provider = h.c.providers.create({ name: "direct", type: "openai_completion", baseUrl: "http://provider.invalid/v1", apiKey: "k" });
    expect(h.c.providers.toUpstream(provider).proxy).toBeNull();
    expect(h.c.proxies.forProvider(null)).toBeNull();
    expect(h.c.proxies.forProvider(undefined)).toBeNull();
  });
});

describe("delete", () => {
  it("invalid id 400, unknown id 404", async () => {
    const bad = await h.admin({ method: "DELETE", url: "/proxies/abc" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });
    const missing = await h.admin({ method: "DELETE", url: "/proxies/99999" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });
  });
});

describe("POST /proxies/test", () => {
  it("needs a saved id or an inline proxy", async () => {
    const res = await h.admin({ method: "POST", url: "/proxies/test", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "provide either a saved proxy id or an inline proxy to test" });
  });

  it("unknown id 404; malformed body 400", async () => {
    const missing = await h.admin({ method: "POST", url: "/proxies/test", payload: { id: 99999 } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const bad = await h.admin({ method: "POST", url: "/proxies/test", payload: { id: "x" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "id: Expected number, received string" });

    const url = await h.admin({ method: "POST", url: "/proxies/test", payload: { id: 1, url: "not a url" } });
    expect(url.statusCode).toBe(400);
    expect(url.json()).toEqual({ error: "url: Invalid url" });
  });

  it("an inline proxy on a non-proxy port fails in-body with the bare guard message", async () => {
    const res = await h.admin({ method: "POST", url: "/proxies/test", payload: { proxy: { name: "x", host: "127.0.0.1", port: 25 } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false,
      status: 0,
      latencyMs: expect.any(Number),
      url: "https://api.openai.com/v1/models",
      message: "proxy x (http://127.0.0.1:25) uses port 25, which is not a proxy port",
    });
  });

  it("any HTTP answer through the proxy is a success -- a 401 from the probe URL included", async () => {
    const id = (await create({ name: "probe", host: "probe.local", port: 8080, username: "u", password: "probe-pw" })).json().proxy.id;
    const getJson = vi.spyOn(h.c.transport, "getJson").mockResolvedValue({ status: 401, json: {}, text: "" } as never);

    const res = await h.admin({ method: "POST", url: "/proxies/test", payload: { id, url: "https://example.test/ping" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, status: 401, url: "https://example.test/ping", latencyMs: expect.any(Number) });
    expect(body.message).toContain("reached https://example.test/ping through");
    expect(body.message).toContain("(HTTP 401)");
    expect(res.body).not.toContain("probe-pw");

    // The probe goes out through the saved proxy, decrypted, with a 15 s budget.
    expect(getJson).toHaveBeenCalledTimes(1);
    const [target, headers, opts] = getJson.mock.calls[0];
    expect(target).toBe("https://example.test/ping");
    expect(headers).toEqual({});
    expect(opts).toMatchObject({ timeoutMs: 15_000, proxy: { id, host: "probe.local", port: 8080, username: "u", password: "probe-pw" } });
  });

  it("defaults the probe URL, and an inline proxy is tested with id 0", async () => {
    const getJson = vi.spyOn(h.c.transport, "getJson").mockResolvedValue({ status: 200, json: {}, text: "" } as never);
    const res = await h.admin({ method: "POST", url: "/proxies/test", payload: { proxy: { name: "inline", host: "inline.local", port: 8080 } } });
    expect(res.json()).toMatchObject({ ok: true, status: 200, url: "https://api.openai.com/v1/models" });
    expect(getJson.mock.calls[0][2]).toMatchObject({ proxy: { id: 0, name: "inline", scheme: "http", host: "inline.local", port: 8080, username: null, password: null } });
  });

  it("a transport failure is reported in-body with the target and the reason", async () => {
    vi.spyOn(h.c.transport, "getJson").mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await h.admin({ method: "POST", url: "/proxies/test", payload: { proxy: { name: "down", host: "down.local", port: 8080 } } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: false, status: 0, url: "https://api.openai.com/v1/models" });
    expect(body.message).toMatch(/^could not reach https:\/\/api\.openai\.com\/v1\/models through .*: ECONNREFUSED$/);
  });
});

describe("a manager", () => {
  it("is refused every write and the probe, with the action named", async () => {
    const cases: Array<[Parameters<AdminHarness["manager"]>[0], string]> = [
      [{ method: "POST", url: "/proxies", payload: { name: "m", host: "h", port: 8080 } }, "only an admin can create proxies"],
      [{ method: "PATCH", url: "/proxies/1", payload: { name: "m" } }, "only an admin can modify proxies"],
      [{ method: "DELETE", url: "/proxies/1" }, "only an admin can delete proxies"],
      [{ method: "POST", url: "/proxies/test", payload: { id: 1 } }, "only an admin can test proxies"],
      // The gate comes before id validation: a malformed id is still a 403.
      [{ method: "PATCH", url: "/proxies/abc", payload: {} }, "only an admin can modify proxies"],
      [{ method: "DELETE", url: "/proxies/abc" }, "only an admin can delete proxies"],
    ];
    for (const [call, error] of cases) {
      const res = await h.manager(call);
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect(res.json()).toEqual({ error });
    }
    expect(h.c.proxies.getByName("m")).toBeUndefined();
  });
});
