import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hydro-stats-"));
process.env.DATA_DIR = dir;

import { loadConfig } from "../src/config";
import { setConfig } from "../src/context";
import { openDatabase, closeDatabase, getDb } from "../src/db";
import { verifyOrInitMasterKey } from "../src/security/masterKey";
import { requestLogs } from "../src/db/schema";
import { byModelProvider, byService, summary } from "../src/services/stats";

function log(status: number, service: string, attemptPath: unknown, totalTokens: number) {
  return {
    serviceName: service,
    ingressFormat: "openai" as const,
    httpStatus: status,
    totalTokens,
    attemptPath,
  };
}

beforeAll(() => {
  const cfg = loadConfig();
  setConfig(cfg);
  const db = openDatabase(cfg.dataDir);
  verifyOrInitMasterKey(db, cfg.masterKey);
  getDb()
    .insert(requestLogs)
    .values([
      log(200, "svc-a", [{ step: 0, model: "m1", provider: "p1", httpStatus: 200 }], 10),
      log(200, "svc-a", [{ step: 0, model: "m1", provider: "p2", httpStatus: 200 }], 20),
      // an agent-shaped path: winner is the last nested call's attempt.
      log(200, "svc-b", [{ calls: [{ attempts: [{ model: "m2", provider: "p1", httpStatus: 200 }] }] }], 5),
      // an error is not attributed to any model/provider.
      log(500, "svc-b", [{ step: 0, model: "m1", provider: "p1", httpStatus: 500 }], 0),
    ])
    .run();
});

afterAll(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

describe("byModelProvider", () => {
  it("groups successful requests by the winning model/provider (errors excluded)", () => {
    const r = byModelProvider({});
    expect(r.capped).toBe(false);
    // m1 won twice (10+20), m2 once (5). The 500 is excluded.
    expect(r.models).toEqual([
      { key: "m1", requests: 2, totalTokens: 30 },
      { key: "m2", requests: 1, totalTokens: 5 },
    ]);
    // p1 won twice (m1 + m2 nested), p2 once.
    const p1 = r.providers.find((p) => p.key === "p1");
    const p2 = r.providers.find((p) => p.key === "p2");
    expect(p1).toEqual({ key: "p1", requests: 2, totalTokens: 15 });
    expect(p2).toEqual({ key: "p2", requests: 1, totalTokens: 20 });
  });

  it("summary and by-service stay exact over all rows", () => {
    expect(summary({}).requests).toBe(4);
    expect(summary({}).errors).toBe(1);
    expect(byService({}).find((g) => g.key === "svc-a")?.requests).toBe(2);
  });
});
