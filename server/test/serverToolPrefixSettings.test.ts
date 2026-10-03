import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { openDatabase, type OpenedDatabase } from "../src/db";
import { SettingsRepo } from "../src/persistence/settingsRepo";
import { settingsRoutes } from "../src/transport/admin/settingsRoutes";
import type { Container } from "../src/composition/container";

let dir: string;
let opened: OpenedDatabase;
let settings: SettingsRepo;
let app: FastifyInstance;
const url = "/server-tool-name-prefix";
const admin = { "x-fixture-role": "admin" };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-prefix-settings-"));
  opened = openDatabase(dir);
  settings = new SettingsRepo(opened.db);
  app = Fastify();
  app.addHook("onRequest", async req => {
    const role = req.headers["x-fixture-role"];
    if (role === "admin" || role === "manager") req.user = { uid: 1, username: "fixture", role };
  });
  await settingsRoutes(app, { settings } as unknown as Container);
});
afterEach(async () => {
  await app.close();
  opened.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("server tool name prefix setting", () => {
  it("defaults only when missing, preserving explicit empty and exact nonempty strings across reopen", () => {
    expect(settings.serverToolNamePrefix()).toBe("provider_server_side_");
    for (const prefix of ["", "Case-Sensitive_9"]) {
      settings.setServerToolNamePrefix(prefix);
      expect(settings.get("server_tool_name_prefix")).toBe(prefix);
      opened.sqlite.close();
      opened = openDatabase(dir);
      settings = new SettingsRepo(opened.db);
      expect(settings.serverToolNamePrefix()).toBe(prefix);
    }
    settings.clear("server_tool_name_prefix");
    expect(settings.serverToolNamePrefix()).toBe("provider_server_side_");
  });

  it.each(["", "custom_", "Case-Sensitive_9", "x".repeat(64)])("saves and reads the exact valid prefix %j", async prefix => {
    const response = await app.inject({ method: "PUT", url, headers: admin, payload: { prefix } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ prefix });
    expect((await app.inject({ url, headers: admin })).json()).toEqual({ prefix });
    expect(new SettingsRepo(opened.db).serverToolNamePrefix()).toBe(prefix);
  });

  it.each([" ", " padded_", "trailing_ ", "bad.prefix", "bad/prefix", "bad:prefix", "a\nb", "x".repeat(65), 5, null, undefined])("rejects invalid prefix %j without changing saved settings", async prefix => {
    settings.setServerToolNamePrefix("saved_");
    const response = await app.inject({ method: "PUT", url, headers: admin, payload: { prefix } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBeTruthy();
    expect(settings.serverToolNamePrefix()).toBe("saved_");
  });

  it("returns the default and permits retry after validation failure", async () => {
    expect((await app.inject({ url, headers: admin })).json()).toEqual({ prefix: "provider_server_side_" });
    expect((await app.inject({ method: "PUT", url, headers: admin, payload: { prefix: "bad prefix" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url, headers: admin, payload: { prefix: "" } })).statusCode).toBe(200);
    expect(settings.serverToolNamePrefix()).toBe("");
  });

  it.each([undefined, "manager"])("denies reads and writes for role %j", async role => {
    const headers = role ? { "x-fixture-role": role } : {};
    expect((await app.inject({ url, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url, headers, payload: { prefix: "change_" } })).statusCode).toBe(403);
    expect(settings.serverToolNamePrefix()).toBe("provider_server_side_");
  });
});
