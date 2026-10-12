/**
 * Characterization of the catalog admin routes (models, mappings,
 * provider-models): every status code and JSON body as it is today, so a
 * refactor onto shared CRUD scaffolding cannot change one unnoticed.
 *
 * Several of these differ from the other admin route files on purpose of
 * history rather than design; the tests name each such difference where it is
 * pinned (search for "differs from").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;
let providerId: number;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FAMILY_ENUM = "Invalid enum value. Expected 'openai_completion' | 'anthropic' | 'openai_responses', received 'bogus'";

beforeAll(async () => {
  h = await startAdminHarness("cov-catalog");
  providerId = h.c.providers.create({ name: "prov", type: "openai_completion", baseUrl: "http://provider.invalid/v1", apiKey: "k" }).id;
});

afterAll(async () => {
  await h.close();
});

describe("models", () => {
  let modelId: number;

  it("POST creates with 201 and returns the row (createdAt as an ISO string, unlike providers)", async () => {
    const res = await h.admin({ method: "POST", url: "/models", payload: { name: "gpt" } });
    expect(res.statusCode).toBe(201);
    const { model } = res.json();
    expect(model).toEqual({ id: expect.any(Number), name: "gpt", description: null, enabled: true, createdAt: expect.stringMatching(ISO) });
    modelId = model.id;
  });

  it("POST accepts description and enabled", async () => {
    const res = await h.admin({ method: "POST", url: "/models", payload: { name: "off", description: "d", enabled: false } });
    expect(res.statusCode).toBe(201);
    expect(res.json().model).toMatchObject({ name: "off", description: "d", enabled: false });
  });

  it("POST rejects an invalid body with 400 and a `path: message` error", async () => {
    const cases: Array<[unknown, string]> = [
      [{}, "name: Required"],
      [{ name: "" }, "name: String must contain at least 1 character(s)"],
      [{ name: "x".repeat(121) }, "name: String must contain at most 120 character(s)"],
      [{ name: 5 }, "name: Expected string, received number"],
      [undefined, "(root): Required"],
    ];
    for (const [payload, error] of cases) {
      const res = await h.admin({ method: "POST", url: "/models", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
    expect((await h.admin({ method: "POST", url: "/models", payload: { name: "x".repeat(120) } })).statusCode).toBe(201);
  });

  it("POST with a name that exists is a 409 from the app-wide constraint mapper", async () => {
    const res = await h.admin({ method: "POST", url: "/models", payload: { name: "gpt" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "resource already exists (unique constraint)" });
  });

  it("GET lists every model", async () => {
    const res = await h.admin({ url: "/models" });
    expect(res.statusCode).toBe(200);
    const { models } = res.json();
    expect(models.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(["gpt", "off"]));
    expect(Object.keys(models[0]).sort()).toEqual(["createdAt", "description", "enabled", "id", "name"]);
  });

  it("PATCH updates, and an empty patch returns the row unchanged", async () => {
    const res = await h.admin({ method: "PATCH", url: `/models/${modelId}`, payload: { description: "edited", enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ model: { id: modelId, name: "gpt", description: "edited", enabled: false, createdAt: expect.stringMatching(ISO) } });

    const noop = await h.admin({ method: "PATCH", url: `/models/${modelId}`, payload: {} });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().model).toMatchObject({ id: modelId, name: "gpt", description: "edited", enabled: false });
  });

  it("PATCH: invalid id 400, unknown id 404, invalid body 400 -- existence is checked BEFORE the body", async () => {
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      const res = await h.admin({ method: "PATCH", url: `/models/${bad}`, payload: {} });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toEqual({ error: "invalid id" });
    }
    const missing = await h.admin({ method: "PATCH", url: "/models/99999", payload: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const badBody = await h.admin({ method: "PATCH", url: `/models/${modelId}`, payload: { name: 5 } });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json()).toEqual({ error: "name: Expected string, received number" });

    // Unknown id + invalid body: the 404 wins here (mappings answer 400, below).
    const both = await h.admin({ method: "PATCH", url: "/models/99999", payload: { name: 5 } });
    expect(both.statusCode).toBe(404);
  });

  it("DELETE: invalid id 400, unknown id 404, success 200 {ok:true}", async () => {
    const bad = await h.admin({ method: "DELETE", url: "/models/abc" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "DELETE", url: "/models/99999" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const created = (await h.admin({ method: "POST", url: "/models", payload: { name: "doomed" } })).json().model.id;
    const ok = await h.admin({ method: "DELETE", url: `/models/${created}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(h.c.models.get(created)).toBeUndefined();
    expect((await h.admin({ method: "DELETE", url: `/models/${created}` })).statusCode).toBe(404);
  });

  it("deleting a model that is still mapped succeeds and takes its mappings with it", async () => {
    const id = (await h.admin({ method: "POST", url: "/models", payload: { name: "mapped" } })).json().model.id;
    const mapping = h.c.mappings.create({ modelId: id, providerId, upstreamModel: "up" });
    const res = await h.admin({ method: "DELETE", url: `/models/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(h.c.mappings.list().some((m) => m.id === mapping.id)).toBe(false);
  });

  it("is open to a manager: no admin gate on any catalog route", async () => {
    expect((await h.manager({ url: "/models" })).statusCode).toBe(200);
    const created = await h.manager({ method: "POST", url: "/models", payload: { name: "by-manager" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().model.id;
    expect((await h.manager({ method: "PATCH", url: `/models/${id}`, payload: { description: "m" } })).statusCode).toBe(200);
    expect((await h.manager({ method: "DELETE", url: `/models/${id}` })).statusCode).toBe(200);
  });

  it("requires a session", async () => {
    const res = await h.as(null, { url: "/models" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("mappings", () => {
  let modelId: number;
  let mappingId: number;

  beforeAll(() => {
    modelId = h.c.models.create({ name: "map-model" }).id;
  });

  it("POST creates with 201 and returns the row", async () => {
    const res = await h.admin({ method: "POST", url: "/mappings", payload: { modelId, providerId, upstreamModel: "up-1" } });
    expect(res.statusCode).toBe(201);
    const { mapping } = res.json();
    expect(mapping).toEqual({
      id: expect.any(Number),
      modelId,
      providerId,
      upstreamModel: "up-1",
      families: null,
      priority: 0,
      enabled: true,
      createdAt: expect.stringMatching(ISO),
    });
    mappingId = mapping.id;
  });

  it("POST: the same (model, provider) pair again is 409", async () => {
    const res = await h.admin({ method: "POST", url: "/mappings", payload: { modelId, providerId, upstreamModel: "other" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "this model is already mapped to that provider" });
  });

  it("POST: an unknown model or provider is a 400 (not a 404)", async () => {
    const noModel = await h.admin({ method: "POST", url: "/mappings", payload: { modelId: 99999, providerId, upstreamModel: "up" } });
    expect(noModel.statusCode).toBe(400);
    expect(noModel.json()).toEqual({ error: "model not found" });

    const noProvider = await h.admin({ method: "POST", url: "/mappings", payload: { modelId, providerId: 99999, upstreamModel: "up" } });
    expect(noProvider.statusCode).toBe(400);
    expect(noProvider.json()).toEqual({ error: "provider not found" });
  });

  it("POST rejects an invalid body with 400, every issue joined by '; '", async () => {
    const cases: Array<[unknown, string]> = [
      [{}, "modelId: Required; providerId: Required; upstreamModel: Required"],
      [{ modelId, providerId, upstreamModel: "" }, "upstreamModel: String must contain at least 1 character(s)"],
      [{ modelId: 0, providerId, upstreamModel: "u" }, "modelId: Number must be greater than 0"],
      [{ modelId, providerId, upstreamModel: "u", families: ["bogus"] }, `families.0: ${FAMILY_ENUM}`],
      [{ modelId, providerId, upstreamModel: "u", priority: 1.5 }, "priority: Expected integer, received float"],
    ];
    for (const [payload, error] of cases) {
      const res = await h.admin({ method: "POST", url: "/mappings", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
  });

  it("GET lists mappings", async () => {
    const res = await h.admin({ url: "/mappings" });
    expect(res.statusCode).toBe(200);
    expect(res.json().mappings).toEqual(expect.arrayContaining([expect.objectContaining({ id: mappingId, modelId, providerId })]));
  });

  it("PATCH updates fields, and an empty patch returns the row unchanged", async () => {
    const res = await h.admin({
      method: "PATCH",
      url: `/mappings/${mappingId}`,
      payload: { upstreamModel: "up-2", priority: 3, enabled: false, families: ["anthropic"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mapping).toMatchObject({ id: mappingId, upstreamModel: "up-2", priority: 3, enabled: false, families: ["anthropic"] });

    const noop = await h.admin({ method: "PATCH", url: `/mappings/${mappingId}`, payload: {} });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().mapping).toMatchObject({ id: mappingId, upstreamModel: "up-2", priority: 3, enabled: false });
  });

  it("PATCH: invalid id 400, unknown id 404, invalid body 400 -- the body is checked BEFORE existence (differs from models)", async () => {
    const bad = await h.admin({ method: "PATCH", url: "/mappings/abc", payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ method: "PATCH", url: "/mappings/99999", payload: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });

    const badBody = await h.admin({ method: "PATCH", url: `/mappings/${mappingId}`, payload: { priority: "x" } });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json()).toEqual({ error: "priority: Expected number, received string" });

    const both = await h.admin({ method: "PATCH", url: "/mappings/99999", payload: { priority: "x" } });
    expect(both.statusCode).toBe(400);
    expect(both.json()).toEqual({ error: "priority: Expected number, received string" });
  });

  it("DELETE has no existence check: an unknown id still answers 200 {ok:true} (differs from models)", async () => {
    const missing = await h.admin({ method: "DELETE", url: "/mappings/99999" });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual({ ok: true });

    const bad = await h.admin({ method: "DELETE", url: "/mappings/abc" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const ok = await h.admin({ method: "DELETE", url: `/mappings/${mappingId}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(h.c.mappings.list().some((m) => m.id === mappingId)).toBe(false);
  });

  it("is open to a manager", async () => {
    const m = h.c.models.create({ name: "mgr-map-model" }).id;
    const created = await h.manager({ method: "POST", url: "/mappings", payload: { modelId: m, providerId, upstreamModel: "u" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().mapping.id;
    expect((await h.manager({ url: "/mappings" })).statusCode).toBe(200);
    expect((await h.manager({ method: "PATCH", url: `/mappings/${id}`, payload: { priority: 1 } })).statusCode).toBe(200);
    expect((await h.manager({ method: "DELETE", url: `/mappings/${id}` })).statusCode).toBe(200);
  });
});

describe("provider-models", () => {
  it("GET groups every stored discovery list by provider", async () => {
    const empty = await h.admin({ url: "/provider-models" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ providerModels: [] });

    h.c.providerModels.replaceForProvider(providerId, ["a", "b"]);
    const res = await h.manager({ url: "/provider-models" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providerModels: [{ providerId, models: ["a", "b"], fetchedAt: expect.any(Number) }] });
  });
});

describe("unknown admin path", () => {
  it("answers a JSON 404", async () => {
    const res = await h.admin({ url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
