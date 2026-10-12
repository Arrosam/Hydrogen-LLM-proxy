/**
 * Characterization of admin-route validation details that the de-duplication
 * pass touches and the per-resource suites (coverageAdmin*) do not pin: the
 * exact text and ORDER of multi-issue validation errors on the update schemas
 * (which mirror their create schema with every field optional), which fields
 * an update silently ignores, and the provider test's own field list.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;
let providerId: number;
let modelId: number;
let mappingId: number;
let serviceId: number;

const CHAT = { timeoutMs: 30_000, steps: [{ model: "m", provider: "p" }] };

beforeAll(async () => {
  h = await startAdminHarness("cov-dedup-admin", { ALLOW_PRIVATE_UPSTREAMS: "1" });
  providerId = h.c.providers.create({ name: "p", type: "openai_completion", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }).id;
  modelId = h.c.models.create({ name: "m" }).id;
  mappingId = h.c.mappings.create({ modelId, providerId, upstreamModel: "up" }).id;
  const created = await h.admin({ method: "POST", url: "/services", payload: { name: "svc", steps: CHAT } });
  expect(created.statusCode).toBe(201);
  serviceId = created.json().service.id;
});

afterAll(async () => {
  await h.close();
});

const shot = (res: { statusCode: number; body: string }) => ({ status: res.statusCode, body: JSON.parse(res.body) as unknown });

const EVERY_PROVIDER_FIELD_WRONG = {
  name: "",
  type: "bogus",
  baseUrl: "ftp://example.com",
  altEndpoints: [{ type: "nope", baseUrl: "ftp://alt.example.com" }],
  apiKey: 5,
  extraHeaders: { a: 1 },
  maxOutputTokens: 0,
  proxyId: -1,
  enabled: "yes",
  availableModels: [""],
};

describe("provider schemas", () => {
  it("create and update report the same issues in the same order", async () => {
    const create = await h.admin({ method: "POST", url: "/providers", payload: EVERY_PROVIDER_FIELD_WRONG });
    const update = await h.admin({ method: "PATCH", url: `/providers/${providerId}`, payload: EVERY_PROVIDER_FIELD_WRONG });
    expect(shot(create)).toMatchSnapshot("create");
    expect(shot(update)).toMatchSnapshot("update");
  });

  it("create requires name, type and baseUrl; update requires nothing", async () => {
    expect(shot(await h.admin({ method: "POST", url: "/providers", payload: {} }))).toMatchSnapshot("create {}");
    const res = await h.admin({ method: "PATCH", url: `/providers/${providerId}`, payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it("update accepts nulls where create does and rejects a null name / type / baseUrl", async () => {
    const ok = await h.admin({ method: "PATCH", url: `/providers/${providerId}`, payload: { altEndpoints: null, extraHeaders: null, maxOutputTokens: null, proxyId: null } });
    expect(ok.statusCode).toBe(200);
    expect(shot(await h.admin({ method: "PATCH", url: `/providers/${providerId}`, payload: { name: null, type: null, baseUrl: null, enabled: null, availableModels: null } }))).toMatchSnapshot();
  });

  it("the test route validates id, type, baseUrl, apiKey, extraHeaders, proxyId -- in that order -- and ignores the rest", async () => {
    const res = await h.admin({ method: "POST", url: "/providers/test", payload: { ...EVERY_PROVIDER_FIELD_WRONG, id: "one" } });
    expect(shot(res)).toMatchSnapshot("all wrong");
    expect(shot(await h.admin({ method: "POST", url: "/providers/test", payload: {} }))).toMatchSnapshot("{}");
    expect(shot(await h.admin({ method: "POST", url: "/providers/test", payload: { id: 0, type: "openai_completion", baseUrl: "http://127.0.0.1:9/v1" } }))).toMatchSnapshot("id 0");
  });
});

describe("service schemas", () => {
  const WRONG = { toolIds: [0, "x"], name: "", description: 5, enabled: "yes" };

  it("create and update report the same envelope issues in the same order", async () => {
    expect(shot(await h.admin({ method: "POST", url: "/services", payload: { ...WRONG, steps: CHAT } }))).toMatchSnapshot("create");
    expect(shot(await h.admin({ method: "PATCH", url: `/services/${serviceId}`, payload: WRONG }))).toMatchSnapshot("update");
  });

  it("more than 64 tool ids is refused on both", async () => {
    const toolIds = Array.from({ length: 65 }, (_, i) => i + 1);
    expect(shot(await h.admin({ method: "POST", url: "/services", payload: { name: "many", steps: CHAT, toolIds } }))).toMatchSnapshot("create");
    expect(shot(await h.admin({ method: "PATCH", url: `/services/${serviceId}`, payload: { toolIds } }))).toMatchSnapshot("update");
  });

  it("an update without steps keeps the definition; a null description clears it", async () => {
    const res = await h.admin({ method: "PATCH", url: `/services/${serviceId}`, payload: { description: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toMatchObject({ name: "svc", description: null });
    expect(res.json().service.steps.steps[0]).toMatchObject({ model: "m", provider: "p" });
  });

  it("an update with invalid steps answers the prefixed definition error", async () => {
    expect(shot(await h.admin({ method: "PATCH", url: `/services/${serviceId}`, payload: { steps: { steps: [] } } }))).toMatchSnapshot("empty steps");
    expect(shot(await h.admin({ method: "PATCH", url: `/services/${serviceId}`, payload: { steps: "nope" } }))).toMatchSnapshot("not an object");
    expect(shot(await h.admin({ method: "PATCH", url: `/services/${serviceId}`, payload: { steps: { timeoutMs: 30_000, steps: [{ model: "ghost", provider: "p" }] } } }))).toMatchSnapshot("unmapped pair");
  });

  it("the OCR test maps an invalid ocr block and invalid ad-hoc steps like a definition", async () => {
    const image = { mediaType: "image/png", data: "aGk=" };
    expect(shot(await h.admin({ method: "POST", url: "/services/test-ocr", payload: { image, ocr: { timeoutMs: "soon" } } }))).toMatchSnapshot("bad ocr");
    expect(shot(await h.admin({ method: "POST", url: "/services/test-ocr", payload: { image, ocr: { steps: [{ model: "ghost", provider: "p" }] } } }))).toMatchSnapshot("unmapped ocr steps");
    expect(shot(await h.admin({ method: "POST", url: "/services/test-ocr", payload: { image: { mediaType: "text/plain", data: "" }, ocr: {} } }))).toMatchSnapshot("bad image");
  });

  it("the dry-run maps invalid ad-hoc steps the same way", async () => {
    expect(shot(await h.admin({ method: "POST", url: "/services/test", payload: { steps: { steps: [] } } }))).toMatchSnapshot();
  });
});

describe("mapping schemas", () => {
  it("update validates upstreamModel, families, priority, enabled -- in that order", async () => {
    const wrong = { upstreamModel: "", families: ["bogus"], priority: 1.5, enabled: "yes" };
    expect(shot(await h.admin({ method: "PATCH", url: `/mappings/${mappingId}`, payload: wrong }))).toMatchSnapshot("update");
    expect(shot(await h.admin({ method: "POST", url: "/mappings", payload: { ...wrong, modelId: 0, providerId: "x" } }))).toMatchSnapshot("create");
  });

  it("update ignores modelId / providerId, even invalid ones", async () => {
    const res = await h.admin({ method: "PATCH", url: `/mappings/${mappingId}`, payload: { modelId: "x", providerId: 999, priority: 3 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().mapping).toMatchObject({ id: mappingId, modelId, providerId, priority: 3 });
  });

  it("an empty update is accepted and families may be null", async () => {
    expect((await h.admin({ method: "PATCH", url: `/mappings/${mappingId}`, payload: {} })).statusCode).toBe(200);
    expect((await h.admin({ method: "PATCH", url: `/mappings/${mappingId}`, payload: { families: null } })).statusCode).toBe(200);
  });
});

describe("hosted tool schema rejections", () => {
  const TOOL = { name: "t1", url: "https://adapter.invalid/run", parameters: { type: "object" }, bodyTemplate: {}, headers: {} };

  it("create and patch answer their own text for a rejected parameter schema", async () => {
    const created = await h.admin({ method: "POST", url: "/tools", payload: TOOL });
    expect(created.statusCode).toBe(201);
    const id = created.json().tool.id;
    const bad = { ...TOOL, name: "t2", parameters: { $ref: "https://elsewhere.invalid/schema.json" } };
    expect(shot(await h.admin({ method: "POST", url: "/tools", payload: bad }))).toMatchSnapshot("create");
    expect(shot(await h.admin({ method: "PATCH", url: `/tools/${id}`, payload: { ...bad, name: "t1" } }))).toMatchSnapshot("patch");
    expect(shot(await h.admin({ method: "PATCH", url: "/tools/99999", payload: TOOL }))).toMatchSnapshot("patch unknown");
    expect(shot(await h.admin({ method: "POST", url: "/tools/preview", payload: { bodyTemplate: "{{nope.x}}", arguments: {}, toolName: "t" } }))).toMatchSnapshot("preview");
  });
});
