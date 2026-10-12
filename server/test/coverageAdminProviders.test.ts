/**
 * Characterization of the provider admin routes: exact status codes and JSON
 * bodies for create / patch / delete / test / available-models, as an admin
 * and as a manager. The upstream is never contacted: the transport's getJson
 * is stubbed wherever a route would reach out.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;

const BASE = { name: "prov", type: "openai_completion", baseUrl: "http://provider.invalid/v1" };
const PUBLIC_KEYS = ["altEndpoints", "baseUrl", "createdAt", "enabled", "extraHeaders", "hasKey", "id", "maxOutputTokens", "name", "proxyId", "type"];
const TYPE_ENUM = "Invalid enum value. Expected 'openai_completion' | 'anthropic' | 'openai_responses', received 'bogus'";

beforeAll(async () => {
  h = await startAdminHarness("cov-providers");
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const create = (payload: unknown) => h.admin({ method: "POST", url: "/providers", payload });

describe("create", () => {
  it("answers 201 with the public row: hasKey instead of the key, createdAt in epoch ms", async () => {
    const res = await create({ ...BASE, apiKey: "sk-provider-secret", extraHeaders: { "x-org": "o" }, maxOutputTokens: 4096 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      provider: {
        id: expect.any(Number),
        name: "prov",
        type: "openai_completion",
        baseUrl: "http://provider.invalid/v1",
        hasKey: true,
        extraHeaders: { "x-org": "o" },
        maxOutputTokens: 4096,
        altEndpoints: null,
        proxyId: null,
        enabled: true,
        createdAt: expect.any(Number),
      },
    });
    expect(res.body).not.toContain("sk-provider-secret");
  });

  it("without a key: hasKey false", async () => {
    const res = await create({ ...BASE, name: "keyless" });
    expect(res.statusCode).toBe(201);
    expect(res.json().provider).toMatchObject({ name: "keyless", hasKey: false, extraHeaders: null, maxOutputTokens: null });
  });

  it("stores the discovered model list sent along with the save", async () => {
    const res = await create({ ...BASE, name: "with-models", availableModels: ["a", "b"] });
    expect(res.statusCode).toBe(201);
    const id = res.json().provider.id;
    expect(res.json().provider).not.toHaveProperty("availableModels");

    const list = await h.admin({ url: `/providers/${id}/available-models` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ providerId: id, models: ["a", "b"], fetchedAt: expect.any(Number) });
  });

  it("a duplicate name is a 409 from the app-wide constraint mapper", async () => {
    const res = await create(BASE);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "resource already exists (unique constraint)" });
  });

  it("rejects an invalid body with 400 and a `path: message` error", async () => {
    const endpoint = { type: "anthropic", baseUrl: "http://alt.invalid" };
    const cases: Array<[unknown, string]> = [
      [{}, "name: Required; type: Required; baseUrl: Required"],
      [{ ...BASE, name: "x", baseUrl: "ftp://x" }, "baseUrl: baseUrl must use http or https"],
      [{ ...BASE, name: "x", type: "bogus" }, `type: ${TYPE_ENUM}`],
      [{ ...BASE, name: "" }, "name: String must contain at least 1 character(s)"],
      [{ ...BASE, name: "x", maxOutputTokens: 0 }, "maxOutputTokens: Number must be greater than 0"],
      [{ ...BASE, name: "x", proxyId: 0 }, "proxyId: Number must be greater than 0"],
      [{ ...BASE, name: "x", altEndpoints: Array(5).fill(endpoint) }, "altEndpoints: Array must contain at most 4 element(s)"],
      [{ ...BASE, name: "x", extraHeaders: { a: 1 } }, "extraHeaders.a: Expected string, received number"],
    ];
    for (const [payload, error] of cases) {
      const res = await create(payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
    const four = await create({ ...BASE, name: "four-alts", altEndpoints: Array(4).fill(endpoint) });
    expect(four.statusCode).toBe(201);
    expect(four.json().provider.altEndpoints).toHaveLength(4);
  });
});

describe("list", () => {
  it("returns public rows only, to a manager as well", async () => {
    for (const who of [h.admin, h.manager]) {
      const res = await who({ url: "/providers" });
      expect(res.statusCode).toBe(200);
      const { providers } = res.json();
      expect(providers.length).toBeGreaterThan(0);
      for (const p of providers) expect(Object.keys(p).sort()).toEqual(PUBLIC_KEYS);
      expect(res.body).not.toContain("sk-provider-secret");
    }
  });
});

describe("update", () => {
  let id: number;
  beforeAll(async () => {
    id = (await create({ ...BASE, name: "edit-me", apiKey: "sk-edit-secret" })).json().provider.id;
  });

  it("an empty patch returns the row unchanged, key kept", async () => {
    const res = await h.admin({ method: "PATCH", url: `/providers/${id}`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toMatchObject({ id, name: "edit-me", hasKey: true, enabled: true });
    expect(h.c.providers.toUpstream(h.c.providers.get(id)!).apiKey).toBe("sk-edit-secret");
  });

  it("patches fields; omitting apiKey keeps the key, null clears it", async () => {
    const renamed = await h.admin({ method: "PATCH", url: `/providers/${id}`, payload: { name: "edited", enabled: false, maxOutputTokens: 100 } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().provider).toMatchObject({ id, name: "edited", enabled: false, maxOutputTokens: 100, hasKey: true });

    const replaced = await h.admin({ method: "PATCH", url: `/providers/${id}`, payload: { apiKey: "sk-new-secret" } });
    expect(replaced.body).not.toContain("sk-new-secret");
    expect(h.c.providers.toUpstream(h.c.providers.get(id)!).apiKey).toBe("sk-new-secret");

    const cleared = await h.admin({ method: "PATCH", url: `/providers/${id}`, payload: { apiKey: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().provider.hasKey).toBe(false);
  });

  it("availableModels: omitted leaves the stored list alone, [] empties it", async () => {
    await h.admin({ method: "PATCH", url: `/providers/${id}`, payload: { availableModels: ["m1", "m2"] } });
    await h.admin({ method: "PATCH", url: `/providers/${id}`, payload: { name: "edited-again" } });
    expect((await h.admin({ url: `/providers/${id}/available-models` })).json().models).toEqual(["m1", "m2"]);

    await h.admin({ method: "PATCH", url: `/providers/${id}`, payload: { availableModels: [] } });
    expect((await h.admin({ url: `/providers/${id}/available-models` })).json()).toEqual({ providerId: id, models: [], fetchedAt: null });
  });

  it("invalid id 400, unknown id 404, invalid body 400 (existence is checked before the body)", async () => {
    const bad = await h.admin({ method: "PATCH", url: "/providers/abc", payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "PATCH", url: "/providers/99999", payload: { type: "bogus" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const body = await h.admin({ method: "PATCH", url: `/providers/${id}`, payload: { type: "bogus" } });
    expect(body.statusCode).toBe(400);
    expect(body.json()).toEqual({ error: `type: ${TYPE_ENUM}` });
  });
});

describe("delete", () => {
  it("invalid id 400, unknown id 404, success 200 {ok:true}", async () => {
    const bad = await h.admin({ method: "DELETE", url: "/providers/abc" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "DELETE", url: "/providers/99999" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const id = (await create({ ...BASE, name: "doomed" })).json().provider.id;
    const ok = await h.admin({ method: "DELETE", url: `/providers/${id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(h.c.providers.get(id)).toBeUndefined();
  });
});

describe("GET /providers/:id/available-models", () => {
  it("invalid id 400, unknown id 404, a provider with no stored list answers an empty one; open to a manager", async () => {
    const bad = await h.admin({ url: "/providers/abc/available-models" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ url: "/providers/99999/available-models" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const id = (await create({ ...BASE, name: "no-list" })).json().provider.id;
    const res = await h.manager({ url: `/providers/${id}/available-models` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providerId: id, models: [], fetchedAt: null });
  });
});

describe("POST /providers/test", () => {
  let id: number;
  beforeAll(async () => {
    id = (await create({ ...BASE, name: "testable", apiKey: "sk-stored-secret" })).json().provider.id;
  });

  const okList = () => vi.spyOn(h.c.transport, "getJson").mockResolvedValue({ status: 200, json: { data: [{ id: "m1" }, { id: "m2" }] }, text: "" } as never);

  it("rejects an invalid body with 400", async () => {
    const res = await h.admin({ method: "POST", url: "/providers/test", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "type: Required; baseUrl: Required" });
  });

  it("reports the discovered models", async () => {
    okList();
    const res = await h.admin({ method: "POST", url: "/providers/test", payload: { type: "openai_completion", baseUrl: "http://form.invalid/v1", apiKey: "form-key" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 200, message: "Connection OK — 2 models reported.", models: ["m1", "m2"] });
  });

  it("with an id and no apiKey it sends the STORED key", async () => {
    const getJson = okList();
    const res = await h.admin({ method: "POST", url: "/providers/test", payload: { id, type: "openai_completion", baseUrl: "http://form.invalid/v1" } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(getJson.mock.calls[0][1])).toContain("sk-stored-secret");
    expect(res.body).not.toContain("sk-stored-secret");
  });

  it("with an id AND an apiKey it sends the form's key; the stored key is untouched", async () => {
    const getJson = okList();
    const res = await h.admin({ method: "POST", url: "/providers/test", payload: { id, type: "openai_completion", baseUrl: "http://form.invalid/v1", apiKey: "form-key" } });
    expect(res.statusCode).toBe(200);
    const sent = JSON.stringify(getJson.mock.calls[0][1]);
    expect(sent).toContain("form-key");
    expect(sent).not.toContain("sk-stored-secret");
    expect(h.c.providers.toUpstream(h.c.providers.get(id)!).apiKey).toBe("sk-stored-secret");
  });

  it("an unknown id with no apiKey is 404, and nothing is sent", async () => {
    const getJson = okList();
    const res = await h.admin({ method: "POST", url: "/providers/test", payload: { id: 99999, type: "openai_completion", baseUrl: "http://form.invalid/v1" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(getJson).not.toHaveBeenCalled();
  });

  it("an upstream error status and a transport failure both travel in-body under HTTP 200", async () => {
    vi.spyOn(h.c.transport, "getJson").mockResolvedValueOnce({ status: 401, json: null, text: "bad key" } as never);
    const refused = await h.admin({ method: "POST", url: "/providers/test", payload: { type: "anthropic", baseUrl: "http://form.invalid", apiKey: "k" } });
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toEqual({ ok: false, status: 401, message: "Upstream returned 401 for the anthropic models endpoint. bad key", models: [] });

    vi.spyOn(h.c.transport, "getJson").mockRejectedValueOnce(new Error("ENOTFOUND"));
    const down = await h.admin({ method: "POST", url: "/providers/test", payload: { type: "anthropic", baseUrl: "http://form.invalid", apiKey: "k" } });
    expect(down.statusCode).toBe(200);
    expect(down.json()).toEqual({ ok: false, status: 0, message: "ENOTFOUND", models: [] });
  });

  it("goes out through the provider's saved proxy unless the form names another (or none)", async () => {
    const proxy = h.c.proxies.create({ name: "egress", scheme: "http", host: "egress.local", port: 3128 });
    const other = h.c.proxies.create({ name: "other", scheme: "http", host: "other.local", port: 3128 });
    h.c.providers.update(id, { proxyId: proxy.id });
    const getJson = okList();
    const payload = { id, type: "openai_completion", baseUrl: "http://form.invalid/v1" };

    await h.admin({ method: "POST", url: "/providers/test", payload });
    expect(getJson.mock.calls[0][2]).toMatchObject({ proxy: { id: proxy.id, host: "egress.local" } });

    await h.admin({ method: "POST", url: "/providers/test", payload: { ...payload, proxyId: other.id } });
    expect(getJson.mock.calls[1][2]).toMatchObject({ proxy: { id: other.id, host: "other.local" } });

    await h.admin({ method: "POST", url: "/providers/test", payload: { ...payload, proxyId: null } });
    expect(getJson.mock.calls[2][2].proxy).toBeNull();
    h.c.providers.update(id, { proxyId: null });
  });
});

describe("a manager", () => {
  it("is refused every write, with the action named, before the id is even validated", async () => {
    const cases: Array<[Parameters<AdminHarness["manager"]>[0], string]> = [
      [{ method: "POST", url: "/providers", payload: { ...BASE, name: "rogue" } }, "only an admin can create providers"],
      [{ method: "PATCH", url: "/providers/1", payload: { name: "x" } }, "only an admin can modify providers"],
      [{ method: "PATCH", url: "/providers/abc", payload: {} }, "only an admin can modify providers"],
      [{ method: "DELETE", url: "/providers/1" }, "only an admin can delete providers"],
      [{ method: "POST", url: "/providers/test", payload: { id: 1, type: "openai_completion", baseUrl: "http://x.invalid" } }, "only an admin can test a provider with its stored key"],
    ];
    for (const [call, error] of cases) {
      const res = await h.manager(call);
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect(res.json()).toEqual({ error });
    }
    expect(h.c.providers.list().some((p) => p.name === "rogue")).toBe(false);
  });

  it("may test with the form's own key, even naming a saved provider id", async () => {
    const getJson = vi.spyOn(h.c.transport, "getJson").mockResolvedValue({ status: 200, json: { data: [] }, text: "" } as never);
    const res = await h.manager({ method: "POST", url: "/providers/test", payload: { id: 1, type: "openai_completion", baseUrl: "http://x.invalid/v1", apiKey: "own-key" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 200, message: "Connection OK, but the models endpoint reported no models.", models: [] });
    expect(JSON.stringify(getJson.mock.calls[0][1])).not.toContain("sk-provider-secret");
  });

  it("gets the body-validation 400 before any gate on /test", async () => {
    const res = await h.manager({ method: "POST", url: "/providers/test", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
