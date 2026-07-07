import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import "../src/core/format"; // register wire formats (definition parsing is format-agnostic, but keep parity)
import { ProviderRepo } from "../src/persistence/providerRepo";
import { ModelRepo } from "../src/persistence/modelRepo";
import { MappingRepo } from "../src/persistence/mappingRepo";
import { ServiceRepo } from "../src/persistence/serviceRepo";
import { RequestLogRepo, type LogInsert } from "../src/persistence/requestLogRepo";
import { StatsQueries } from "../src/persistence/statsQueries";
import { Catalog } from "../src/catalog/catalog";
import { ServiceValidator, ServiceValidationError } from "../src/execution/serviceValidator";

let dir: string;
let sqlite: BetterSqlite3.Database;
let db: DB;
let providers: ProviderRepo;
let models: ModelRepo;
let mappings: MappingRepo;
let services: ServiceRepo;
let logs: RequestLogRepo;
let stats: StatsQueries;
let catalog: Catalog;
let validator: ServiceValidator;

const KEY = Buffer.alloc(32, 7);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-test-"));
  const opened = openDatabase(dir);
  db = opened.db;
  sqlite = opened.sqlite;
  providers = new ProviderRepo(db, KEY);
  models = new ModelRepo(db);
  mappings = new MappingRepo(db);
  services = new ServiceRepo(db);
  logs = new RequestLogRepo(db);
  stats = new StatsQueries(db);
  catalog = new Catalog(models, providers, mappings);
  validator = new ServiceValidator(catalog, services);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function insertLog(patch: Partial<LogInsert>): void {
  logs.insert({
    traceId: "t",
    tokenId: null,
    serviceId: null,
    requestedService: "svc",
    servedModel: "gpt-x",
    servedProvider: "prov",
    ingressFormat: "openai_completion",
    egressFormat: "anthropic",
    streaming: false,
    httpStatus: 200,
    requestMethod: "POST",
    requestPath: "/v1/chat/completions",
    requestQuery: null,
    requestHeaders: { authorization: "[redacted]", "content-type": "application/json" },
    requestBody: '{"model":"svc"}',
    responseHeaders: null,
    responseBody: "ok",
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    latencyMs: 10,
    attempts: 1,
    attemptPath: [],
    error: null,
    ...patch,
  });
}

describe("provider key crypto", () => {
  it("stores the key encrypted and round-trips it via toUpstream", () => {
    const p = providers.create({ name: "prov", type: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-secret" });
    expect(p.keyCiphertext).toBeTruthy();
    expect(p.keyCiphertext).not.toContain("sk-secret");
    expect(providers.toUpstream(p).apiKey).toBe("sk-secret");
  });
});

describe("Catalog.resolve", () => {
  it("resolves a mapped (model, provider) to a concrete upstream target", () => {
    const provider = providers.getByName("prov")!;
    const model = models.create({ name: "gpt-x" });
    mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "claude-3-5" });

    const r = catalog.resolve("gpt-x", "prov");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.family).toBe("anthropic");
      expect(r.target.upstreamModel).toBe("claude-3-5");
      expect(r.target.url).toContain("/v1/messages");
      expect(r.target.headers["x-api-key"]).toBe("sk-secret");
    }
    expect(catalog.resolve("ghost", "prov").ok).toBe(false);
  });
});

describe("ServiceValidator + ServiceRepo", () => {
  it("accepts a mapped step chain and rejects an unmapped pair", () => {
    const { def, summary } = validator.validate({ timeoutMs: 5000, steps: [{ model: "gpt-x", provider: "prov" }] });
    expect(summary).toContain("gpt-x@prov");
    expect(() => validator.validate({ timeoutMs: 5000, steps: [{ model: "ghost", provider: "prov" }] })).toThrow(ServiceValidationError);

    const row = services.create({ name: "svc", definition: def });
    expect(row.kind).toBe("model_service");
    expect(services.def(row)).toMatchObject({ steps: [{ model: "gpt-x", provider: "prov" }] });
  });

  it("derives kind micro_agent for an agent definition (legacy kind 'agent')", () => {
    const { def } = validator.validate({
      kind: "agent",
      timeoutMs: 5000,
      stages: [{ name: "only", input: [], steps: [{ model: "gpt-x", provider: "prov" }] }],
    });
    const row = services.create({ name: "agent-svc", definition: def });
    expect(row.kind).toBe("micro_agent");
  });
});

describe("StatsQueries + full-HTTP log capture", () => {
  it("groups by served_model/provider with a plain GROUP BY, and captures the full request", () => {
    insertLog({});
    insertLog({});
    insertLog({});
    insertLog({ servedModel: null, servedProvider: null, httpStatus: 502, responseBody: null, error: "boom", promptTokens: 0, completionTokens: 0, totalTokens: 0 });

    const summary = stats.summary({});
    expect(summary.requests).toBe(4);
    expect(summary.errors).toBe(1);
    expect(summary.totalTokens).toBe(6);

    const mp = stats.byModelProvider({});
    expect(mp.models.find((g) => g.key === "gpt-x")?.requests).toBe(3);
    expect(mp.providers.find((g) => g.key === "prov")?.requests).toBe(3);

    const first = logs.query({ limit: 1, offset: 3 }).rows[0]; // oldest
    const detail = logs.get(first.id)!;
    expect(detail.serviceName).toBe("svc");
    expect(detail.requestPayload).toBe('{"model":"svc"}');
    expect(detail.requestMethod).toBe("POST");
    expect(detail.requestHeaders?.authorization).toBe("[redacted]");
  });
});
