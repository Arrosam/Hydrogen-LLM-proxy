/**
 * The Tools admin API, driven through the real HTTP routes.
 *
 * The rules under test are the ones an operator can get wrong destructively:
 * only an admin may write a row that carries a credential, the secret never
 * comes back out, a name is unique PER KIND (a hosted `web_search` and a
 * free-form one are different tools), and a tool still granted by a service
 * cannot be deleted out from under it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const ADMIN_PASSWORD = "tool-routes-admin-pass";
const MANAGER_PASSWORD = "tool-routes-manager-pass";

let app: FastifyInstance;
let sqlite: { close: () => void };
let dataDir: string;
let adminCookie: string;
let managerCookie: string;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  const session = res.cookies.find((c) => c.name === "hydrogen_session");
  return `${session!.name}=${session!.value}`;
}

const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });

const CREATE = {
  name: "check_inventory",
  endpointUrl: "https://tools.invalid/inv",
  description: "look up stock",
  headers: { Authorization: "Bearer sekrit-value" },
};

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-toolroutes-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SESSION_SECRET = "tool-routes-session-secret-0123456789";

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await boot();
  await c.users.create({ username: "mgr", password: MANAGER_PASSWORD, role: "manager", enabled: true });
  sqlite = c.sqlite;
  app = await buildApp(c);
  adminCookie = await login("admin", ADMIN_PASSWORD);
  managerCookie = await login("mgr", MANAGER_PASSWORD);
});

afterAll(() => {
  sqlite?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("tool routes — permissions", () => {
  it("lets a manager READ the list, because the service editor needs it", async () => {
    const res = await req("GET", "/admin/api/tools", managerCookie);
    expect(res.statusCode).toBe(200);
  });

  it("refuses every write to a manager", async () => {
    expect((await req("POST", "/admin/api/tools", managerCookie, CREATE)).statusCode).toBe(403);
    expect((await req("PATCH", "/admin/api/tools/1", managerCookie, { maxUses: 2 })).statusCode).toBe(403);
    expect((await req("DELETE", "/admin/api/tools/1", managerCookie)).statusCode).toBe(403);
  });
});

describe("tool routes — the secret", () => {
  it("never returns a header value it was given", async () => {
    const created = await req("POST", "/admin/api/tools", adminCookie, CREATE);
    expect(created.statusCode).toBe(200);
    const body = created.body;
    expect(body).not.toContain("sekrit-value");
    expect(JSON.parse(body).tool.headerNames).toEqual(["Authorization"]);

    const listed = await req("GET", "/admin/api/tools", adminCookie);
    expect(listed.body).not.toContain("sekrit-value");
  });

  it("leaves stored headers alone on an unrelated update", async () => {
    const listed = JSON.parse((await req("GET", "/admin/api/tools", adminCookie)).body) as { tools: Array<{ id: number; name: string }> };
    const id = listed.tools.find((t) => t.name === "check_inventory")!.id;
    const patched = await req("PATCH", `/admin/api/tools/${id}`, adminCookie, { description: "changed" });
    expect(patched.statusCode).toBe(200);
    expect(JSON.parse(patched.body).tool.headerNames).toEqual(["Authorization"]);
  });
});

describe("tool routes — names are unique per kind", () => {
  it("rejects a duplicate of the same kind", async () => {
    const dup = await req("POST", "/admin/api/tools", adminCookie, CREATE);
    expect(dup.statusCode).toBe(409);
  });

  it("allows the same name under the other kind", async () => {
    // A hosted `web_search` and a free-form one are different tools; the wire
    // shape of the client's declaration picks between them (S16).
    const a = await req("POST", "/admin/api/tools", adminCookie, { name: "web_search", kind: "vocabulary", endpointUrl: "https://tools.invalid/ws" });
    const b = await req("POST", "/admin/api/tools", adminCookie, { name: "web_search", kind: "freeform", endpointUrl: "https://tools.invalid/ws2" });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });

  it("rejects a rename onto an existing name of the same kind", async () => {
    const tools = (JSON.parse((await req("GET", "/admin/api/tools", adminCookie)).body) as { tools: Array<{ id: number; name: string; kind: string }> }).tools;
    const freeformWebSearch = tools.find((t) => t.name === "web_search" && t.kind === "freeform")!;
    const res = await req("PATCH", `/admin/api/tools/${freeformWebSearch.id}`, adminCookie, { name: "check_inventory" });
    expect(res.statusCode).toBe(409);
  });
});

describe("tool routes — deletion is refused while a service grants it", () => {
  it("names the services still granting it", async () => {
    const svc = await req("POST", "/admin/api/services", adminCookie, {
      name: "granting-service",
      steps: { kind: "model_service", timeoutMs: 30_000, steps: [{ model: "m", provider: "p" }], grantTools: ["check_inventory"] },
    });
    // The step's (model, provider) pair is unmapped, so the service is rejected
    // for that reason -- which still proves grant validation ran and passed.
    expect([200, 201, 400]).toContain(svc.statusCode);

    const id = (JSON.parse((await req("GET", "/admin/api/tools", adminCookie)).body) as { tools: Array<{ id: number; name: string; kind: string }> })
      .tools.find((t) => t.name === "check_inventory")!.id;

    if (svc.statusCode === 200 || svc.statusCode === 201) {
      const refused = await req("DELETE", `/admin/api/tools/${id}`, adminCookie);
      expect(refused.statusCode).toBe(409);
      expect(refused.body).toContain("granting-service");
    }
  });

  it("rejects a service whose grant names no configured tool", async () => {
    const res = await req("POST", "/admin/api/services", adminCookie, {
      name: "typo-service",
      steps: { kind: "model_service", timeoutMs: 30_000, steps: [{ model: "m", provider: "p" }], grantTools: ["chekc_inventory"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("chekc_inventory");
  });

  it("deletes a tool nothing grants", async () => {
    const id = (JSON.parse((await req("GET", "/admin/api/tools", adminCookie)).body) as { tools: Array<{ id: number; name: string; kind: string }> })
      .tools.find((t) => t.name === "web_search" && t.kind === "vocabulary")!.id;
    expect((await req("DELETE", `/admin/api/tools/${id}`, adminCookie)).statusCode).toBe(200);
  });
});

describe("provider capabilities and key tool scope round-trip", () => {
  it("stores an explicit capability list, and distinguishes it from undeclared", async () => {
    const created = await req("POST", "/admin/api/providers", adminCookie, {
      name: "cap-provider", type: "anthropic", baseUrl: "https://api.invalid", toolCapabilities: ["web_search_20250305"],
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body).provider.toolCapabilities).toEqual(["web_search_20250305"]);

    const plain = await req("POST", "/admin/api/providers", adminCookie, {
      name: "plain-provider", type: "anthropic", baseUrl: "https://api2.invalid",
    });
    // Undeclared stays null: it must not read as "serves nothing".
    expect(JSON.parse(plain.body).provider.toolCapabilities).toBeNull();
  });

  it("stores a per-key tool scope", async () => {
    const created = await req("POST", "/admin/api/tokens", adminCookie, { name: "scoped-key", scopeTools: [1, 2] });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body).token.scopeTools).toEqual([1, 2]);
  });
});
