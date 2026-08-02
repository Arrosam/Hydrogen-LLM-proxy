import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import "../src/core/format";
import { ProviderRepo } from "../src/persistence/providerRepo";
import { ProviderModelRepo } from "../src/persistence/providerModelRepo";
import {
  discoverModels,
  MAX_DISCOVERED_MODELS,
  parseModelList,
  type ModelListTransport,
} from "../src/catalog/modelDiscovery";
import type { TransportJsonResult } from "../src/core/upstream/transport";

let dir: string;
let sqlite: BetterSqlite3.Database;
let db: DB;
let providers: ProviderRepo;
let providerModels: ProviderModelRepo;

const KEY = Buffer.alloc(32, 3);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-pm-"));
  const opened = openDatabase(dir);
  db = opened.db;
  sqlite = opened.sqlite;
  providers = new ProviderRepo(db, KEY);
  providerModels = new ProviderModelRepo(db);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A transport that answers one canned response (or throws). */
function fakeTransport(res: Partial<TransportJsonResult> | Error): ModelListTransport {
  return {
    async getJson() {
      if (res instanceof Error) throw res;
      return { status: 200, headers: {}, json: undefined, text: "", ...res };
    },
  };
}

describe("parseModelList", () => {
  it("reads the OpenAI shape", () => {
    const json = { object: "list", data: [{ id: "gpt-4o", object: "model" }, { id: "gpt-4o-mini" }] };
    expect(parseModelList(json)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("reads the Anthropic shape", () => {
    const json = { data: [{ type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }], has_more: false };
    expect(parseModelList(json)).toEqual(["claude-sonnet-4-6"]);
  });

  it("reads the shapes OpenAI-compatible gateways actually send", () => {
    expect(parseModelList(["a", "b"])).toEqual(["a", "b"]);
    expect(parseModelList({ models: [{ name: "llama3" }] })).toEqual(["llama3"]);
    expect(parseModelList({ data: [{ model: "qwen3" }] })).toEqual(["qwen3"]);
  });

  it("preserves order, drops duplicates, blanks and absurd ids", () => {
    const json = {
      data: [{ id: "b" }, { id: " a " }, { id: "b" }, { id: "  " }, { id: "x".repeat(500) }, { nope: 1 }],
    };
    expect(parseModelList(json)).toEqual(["b", "a"]);
  });

  it("caps a runaway list instead of writing all of it", () => {
    const data = Array.from({ length: MAX_DISCOVERED_MODELS + 50 }, (_, i) => ({ id: `m${i}` }));
    expect(parseModelList({ data })).toHaveLength(MAX_DISCOVERED_MODELS);
  });

  it("returns nothing for a response it cannot read", () => {
    expect(parseModelList(undefined)).toEqual([]);
    expect(parseModelList({ error: { message: "nope" } })).toEqual([]);
    expect(parseModelList("<html>404</html>")).toEqual([]);
  });
});

describe("discoverModels", () => {
  const provider = { type: "openai_completion" as const, baseUrl: "https://api.example.com/v1", apiKey: "sk-x" };

  it("reports the models on a 2xx", async () => {
    const r = await discoverModels(fakeTransport({ json: { data: [{ id: "gpt-4o" }] } }), provider);
    expect(r).toMatchObject({ ok: true, status: 200, models: ["gpt-4o"] });
    expect(r.message).toContain("1 model");
  });

  it("succeeds but says so when the endpoint reports nothing", async () => {
    const r = await discoverModels(fakeTransport({ json: { data: [] } }), provider);
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([]);
    expect(r.message).toContain("no models");
  });

  it("fails with the upstream status and body on a non-2xx", async () => {
    const r = await discoverModels(fakeTransport({ status: 401, text: '{"error":"bad key"}' }), provider);
    expect(r).toMatchObject({ ok: false, status: 401, models: [] });
    expect(r.message).toContain("401");
    expect(r.message).toContain("bad key");
  });

  it("turns a transport failure into a readable message, not a throw", async () => {
    const r = await discoverModels(fakeTransport(new Error("getaddrinfo ENOTFOUND")), provider);
    expect(r).toMatchObject({ ok: false, status: 0, models: [] });
    expect(r.message).toContain("ENOTFOUND");
  });
});

describe("ProviderModelRepo", () => {
  it("replaces the whole list rather than accumulating, and keeps report order", () => {
    const p = providers.create({ name: "p1", type: "openai_completion", baseUrl: "https://a.example.com/v1" });

    providerModels.replaceForProvider(p.id, ["gpt-4o", "gpt-4o-mini", "o3"]);
    expect(providerModels.listForProvider(p.id)).toEqual(["gpt-4o", "gpt-4o-mini", "o3"]);

    // A model the provider retired must disappear, not linger.
    providerModels.replaceForProvider(p.id, ["gpt-4o", "gpt-5"]);
    expect(providerModels.listForProvider(p.id)).toEqual(["gpt-4o", "gpt-5"]);

    const one = providerModels.forProvider(p.id);
    expect(one.models).toEqual(["gpt-4o", "gpt-5"]);
    expect(one.fetchedAt).toBeTypeOf("number");
  });

  it("drops duplicates and blanks that the unique index would otherwise reject", () => {
    const p = providers.create({ name: "p2", type: "anthropic", baseUrl: "https://b.example.com" });
    expect(providerModels.replaceForProvider(p.id, ["a", " a ", "", "  ", "b"])).toBe(2);
    expect(providerModels.listForProvider(p.id)).toEqual(["a", "b"]);
  });

  it("writes a list longer than one SQLite statement can bind", () => {
    const p = providers.create({ name: "p3", type: "openai_completion", baseUrl: "https://c.example.com/v1" });
    const many = Array.from({ length: 1500 }, (_, i) => `m${i}`);
    expect(providerModels.replaceForProvider(p.id, many)).toBe(1500);
    expect(providerModels.listForProvider(p.id)).toEqual(many);
  });

  it("groups every provider's list in one read", () => {
    const grouped = providerModels.grouped();
    const p1 = providers.getByName("p1")!;
    const p2 = providers.getByName("p2")!;
    expect(grouped.find((g) => g.providerId === p1.id)?.models).toEqual(["gpt-4o", "gpt-5"]);
    expect(grouped.find((g) => g.providerId === p2.id)?.models).toEqual(["a", "b"]);
  });

  it("lets go of a provider's list when the provider is deleted", () => {
    const p = providers.create({ name: "p4", type: "openai_completion", baseUrl: "https://d.example.com/v1" });
    providerModels.replaceForProvider(p.id, ["x", "y"]);
    providers.delete(p.id);
    expect(providerModels.listForProvider(p.id)).toEqual([]);
    expect(providerModels.grouped().some((g) => g.providerId === p.id)).toBe(false);
  });

  it("reports an empty list for a provider that was never tested", () => {
    const p = providers.create({ name: "p5", type: "anthropic", baseUrl: "https://e.example.com" });
    expect(providerModels.forProvider(p.id)).toEqual({ providerId: p.id, models: [], fetchedAt: null });
  });
});
