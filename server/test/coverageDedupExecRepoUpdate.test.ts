import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { ModelRepo } from "../src/persistence/modelRepo";
import { MappingRepo } from "../src/persistence/mappingRepo";
import { ProviderRepo } from "../src/persistence/providerRepo";
import { ProxyRepo } from "../src/persistence/proxyRepo";
import { ServiceRepo } from "../src/persistence/serviceRepo";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { UserRepo } from "../src/persistence/userRepo";
import { parseService } from "../src/execution/definition";
import { verifyPassword } from "../src/security/passwords";

// Characterization of the repositories' shared CRUD shape and of partial
// updates: `undefined` leaves a column alone, an empty patch writes nothing and
// returns the current row, and each repo's special fields keep their own rules.

const KEY = Buffer.alloc(32, 4);
let dir: string;
let db: DB;
let sqlite: BetterSqlite3.Database;
let writes: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-dedup-repo-"));
  ({ db, sqlite } = openDatabase(dir));
  writes = [];
  const prepare = sqlite.prepare.bind(sqlite);
  (sqlite as unknown as { prepare: (q: string) => unknown }).prepare = (q: string) => {
    if (/^\s*update/i.test(q)) writes.push(q);
    return prepare(q);
  };
});
afterEach(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const steps = (model: string) => parseService({ steps: [{ model, provider: "p" }] });
const agent = () => parseService({ kind: "micro_agent", stages: [{ name: "s", steps: [{ model: "m", provider: "p" }] }] });

describe("repository partial updates", () => {
  it("ModelRepo: list/get/getByName/delete, patch only what is given", () => {
    const repo = new ModelRepo(db);
    const m = repo.create({ name: "m1", description: "d" });
    expect(repo.list()).toEqual([m]);
    expect(repo.get(m.id)).toEqual(m);
    expect(repo.getByName("m1")).toEqual(m);
    expect(repo.getByName("nope")).toBeUndefined();

    expect(repo.update(m.id, {})).toEqual(m);
    expect(repo.update(m.id, { name: undefined, description: undefined, enabled: undefined })).toEqual(m);
    expect(writes).toEqual([]);

    expect(repo.update(m.id, { enabled: false })).toEqual({ ...m, enabled: false });
    expect(repo.update(m.id, { description: null })).toEqual({ ...m, enabled: false, description: null });
    expect(repo.update(m.id, { name: "m2" })?.name).toBe("m2");
    expect(writes).toHaveLength(3);

    expect(repo.update(9999, {})).toBeUndefined();
    expect(repo.update(9999, { name: "x" })).toBeUndefined();
    repo.delete(m.id);
    expect(repo.get(m.id)).toBeUndefined();
    expect(repo.list()).toEqual([]);
  });

  it("MappingRepo: families null is written, undefined is not", () => {
    const model = new ModelRepo(db).create({ name: "m" });
    const provider = new ProviderRepo(db, KEY).create({ name: "p", type: "openai_completion", baseUrl: "https://e.test/v1" });
    const repo = new MappingRepo(db);
    const row = repo.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up", families: ["anthropic"], priority: 3 });
    expect(repo.list()).toEqual([row]);
    expect(repo.get(row.id)).toEqual(row);
    expect(repo.update(row.id, {})).toEqual(row);
    expect(writes).toEqual([]);
    expect(repo.update(row.id, { priority: 0, enabled: false })).toEqual({ ...row, priority: 0, enabled: false });
    expect(repo.update(row.id, { families: null })?.families).toBeNull();
    expect(repo.update(row.id, { upstreamModel: "up2" })).toMatchObject({ upstreamModel: "up2", priority: 0, families: null });
    // The pair itself is not patchable, even when smuggled in.
    expect(repo.update(row.id, { modelId: 77, enabled: true } as never)).toMatchObject({ modelId: model.id, enabled: true });
    repo.delete(row.id);
    expect(repo.get(row.id)).toBeUndefined();
  });

  it("ServiceRepo: a new definition also rewrites kind; nothing else does", () => {
    const repo = new ServiceRepo(db);
    const row = repo.create({ name: "svc", definition: steps("a") });
    expect(row.kind).toBe("model_service");
    expect(repo.list()).toEqual([row]);
    expect(repo.getByName("svc")).toEqual(row);
    expect(repo.update(row.id, {})).toEqual(row);
    expect(writes).toEqual([]);
    expect(repo.update(row.id, { description: "x", enabled: false })).toMatchObject({ description: "x", enabled: false, kind: "model_service" });
    const asAgent = repo.update(row.id, { definition: agent() });
    expect(asAgent?.kind).toBe("micro_agent");
    expect(repo.update(row.id, { name: "svc2" })).toMatchObject({ name: "svc2", kind: "micro_agent" });
    expect(repo.update(row.id, { definition: steps("b") })?.kind).toBe("model_service");
    repo.delete(row.id);
    expect(repo.get(row.id)).toBeUndefined();
  });

  it("ProviderRepo: apiKey undefined leaves, null and '' clear, a value re-encrypts", () => {
    const repo = new ProviderRepo(db, KEY);
    const row = repo.create({ name: "p", type: "openai_completion", baseUrl: "https://e.test/v1", apiKey: "k1" });
    expect(repo.list()).toEqual([row]);
    expect(repo.getByName("p")).toEqual(row);
    expect(repo.update(row.id, {})).toEqual(row);
    expect(repo.update(row.id, { apiKey: undefined })).toEqual(row);
    expect(writes).toEqual([]);

    const renamed = repo.update(row.id, { name: "p2", maxOutputTokens: 5, extraHeaders: { a: "b" }, altEndpoints: null, proxyId: null, enabled: false, type: "anthropic", baseUrl: "https://e2.test" })!;
    expect(renamed).toMatchObject({ name: "p2", maxOutputTokens: 5, extraHeaders: { a: "b" }, enabled: false, type: "anthropic", baseUrl: "https://e2.test", keyCiphertext: row.keyCiphertext });
    expect(repo.toUpstream(renamed).apiKey).toBe("k1");

    const rekeyed = repo.update(row.id, { apiKey: "k2" })!;
    expect(rekeyed.keyCiphertext).not.toBe(row.keyCiphertext);
    expect(repo.toUpstream(rekeyed).apiKey).toBe("k2");
    expect(repo.update(row.id, { apiKey: "" })).toMatchObject({ keyCiphertext: null, keyIv: null, keyTag: null });
    repo.update(row.id, { apiKey: "k3" });
    expect(repo.update(row.id, { apiKey: null })).toMatchObject({ keyCiphertext: null, keyIv: null, keyTag: null, name: "p2" });
    repo.delete(row.id);
    expect(repo.get(row.id)).toBeUndefined();
  });

  it("ProxyRepo: password undefined leaves, null and '' clear, a value re-encrypts", () => {
    const repo = new ProxyRepo(db, KEY);
    const row = repo.create({ name: "px", scheme: "http", host: "h", port: 1, username: "u", password: "s1" });
    expect(repo.list()).toEqual([row]);
    expect(repo.get(row.id)).toEqual(row);
    expect(repo.getByName("px")).toEqual(row);
    expect(repo.update(row.id, {})).toEqual(row);
    expect(writes).toEqual([]);
    const moved = repo.update(row.id, { name: "px2", scheme: "https", host: "h2", port: 2, username: null, enabled: false })!;
    expect(moved).toMatchObject({ name: "px2", scheme: "https", host: "h2", port: 2, username: null, enabled: false, passwordCiphertext: row.passwordCiphertext });
    expect(repo.toEgress(repo.update(row.id, { password: "s2" })!).password).toBe("s2");
    expect(repo.update(row.id, { password: "" })).toMatchObject({ passwordCiphertext: null, passwordIv: null, passwordTag: null });
    repo.update(row.id, { password: "s3" });
    expect(repo.update(row.id, { password: null })).toMatchObject({ passwordCiphertext: null, passwordIv: null, passwordTag: null });
    repo.delete(row.id);
    expect(repo.get(row.id)).toBeUndefined();
  });

  it("TokenRepo: expiresAt converts ms to a Date, null clears it; ownerUserId is not patchable", () => {
    const repo = new TokenRepo(db, KEY);
    const { token } = repo.create({ name: "t", maxRequests: 1 });
    expect(repo.list()).toEqual([token]);
    expect(repo.get(token.id)).toEqual(token);
    expect(repo.update(token.id, {})).toEqual(token);
    expect(writes).toEqual([]);
    const at = Date.UTC(2030, 0, 1);
    expect(repo.update(token.id, { expiresAt: at })?.expiresAt).toEqual(new Date(at));
    expect(repo.update(token.id, { name: "t2", scopeServices: [1], maxRequests: null, maxTokens: 9, enabled: false }))
      .toMatchObject({ name: "t2", scopeServices: [1], maxRequests: null, maxTokens: 9, enabled: false, expiresAt: new Date(at) });
    expect(repo.update(token.id, { expiresAt: null })?.expiresAt).toBeNull();
    expect(repo.update(token.id, { expiresAt: 0 })?.expiresAt).toEqual(new Date(0));
    expect(repo.update(token.id, { ownerUserId: 5, name: "t3" } as never)).toMatchObject({ name: "t3", ownerUserId: null });
    repo.delete(token.id);
    expect(repo.get(token.id)).toBeUndefined();
  });

  it("UserRepo: an empty password is ignored, a real one is re-hashed", async () => {
    const repo = new UserRepo(db);
    const user = await repo.create({ username: "u", password: "first-password", role: "manager" });
    expect(repo.list()).toEqual([user]);
    expect(repo.get(user.id)).toEqual(user);
    expect(repo.getByUsername("u")).toEqual(user);
    expect(await repo.update(user.id, {})).toEqual(user);
    expect(await repo.update(user.id, { password: "" })).toEqual(user);
    expect(writes).toEqual([]);
    expect(await repo.update(user.id, { role: "admin", enabled: false })).toEqual({ ...user, role: "admin", enabled: false });
    const changed = (await repo.update(user.id, { password: "second-password" }))!;
    expect(changed.passwordHash).not.toBe(user.passwordHash);
    expect(await verifyPassword(changed.passwordHash, "second-password")).toBe(true);
    expect(changed).toMatchObject({ role: "admin", enabled: false, mustChangePassword: false });
    expect(await repo.update(9999, { role: "admin" })).toBeUndefined();
    repo.delete(user.id);
    expect(repo.get(user.id)).toBeUndefined();
  });
});
