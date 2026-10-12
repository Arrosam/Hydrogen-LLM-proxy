/**
 * Shared boot for the admin-route characterization suites (coverageAdmin*).
 *
 * Every suite gets its own data directory, a seeded admin (user id 1) and one
 * manager ("mgr"), and two ready-made session cookies. Requests go through
 * Fastify's `inject`, so what is asserted is the real route + guard + error
 * handler stack, never a handler called in isolation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Container } from "../src/composition/container";

export const ADMIN_PASSWORD = "coverage-admin-pass";
export const MANAGER_PASSWORD = "coverage-manager-pass";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface Call {
  method?: Method;
  url: string;
  payload?: unknown;
}

export interface AdminHarness {
  app: FastifyInstance;
  c: Container;
  adminCookie: string;
  managerCookie: string;
  /** Request as the seeded admin. `url` is relative to /admin/api. */
  admin(call: Call): Promise<LightMyRequestResponse>;
  /** Request as the manager. `url` is relative to /admin/api. */
  manager(call: Call): Promise<LightMyRequestResponse>;
  /** Request with an arbitrary (or no) cookie. `url` is relative to /admin/api. */
  as(cookie: string | null, call: Call): Promise<LightMyRequestResponse>;
  login(username: string, password: string): Promise<string>;
  close(): Promise<void>;
}

let ipCounter = 0;

export async function startAdminHarness(tag: string, env: Record<string, string> = {}): Promise<AdminHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `hydrogen-${tag}-`));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SESSION_SECRET = `${tag}-session-secret-0123456789abcdef`;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await boot();
  await c.users.create({ username: "mgr", password: MANAGER_PASSWORD, role: "manager", enabled: true });
  const app = await buildApp(c);

  // Each login comes from its own address, so a suite that signs in often never
  // trips the login rate limit (10 per minute per address) by accident.
  const login = async (username: string, password: string): Promise<string> => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { username, password },
      remoteAddress: `10.99.0.${(ipCounter++ % 250) + 1}`,
    });
    if (res.statusCode !== 200) throw new Error(`login as ${username} failed: ${res.statusCode} ${res.body}`);
    const session = res.cookies.find((k) => k.name === "hydrogen_session");
    if (!session) throw new Error("login set no session cookie");
    return `${session.name}=${session.value}`;
  };

  const adminCookie = await login("admin", ADMIN_PASSWORD);
  const managerCookie = await login("mgr", MANAGER_PASSWORD);

  const as = (cookie: string | null, call: Call): Promise<LightMyRequestResponse> =>
    app.inject({
      method: call.method ?? "GET",
      url: `/admin/api${call.url}`,
      payload: call.payload as never,
      headers: cookie ? { cookie } : {},
    });

  return {
    app,
    c,
    adminCookie,
    managerCookie,
    admin: (call) => as(adminCookie, call),
    manager: (call) => as(managerCookie, call),
    as,
    login,
    close: async () => {
      await app.close();
      c.sqlite.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
