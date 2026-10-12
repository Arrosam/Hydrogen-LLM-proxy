/**
 * T4 — the session lifetime saved through PUT /settings/env takes effect on the
 * next session issued (JWT expiry and cookie Max-Age), falling back to the
 * boot-time SESSION_TTL while it is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { ADMIN_PASSWORD, startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;
const BOOT_TTL_SECONDS = 7_200;

beforeAll(async () => {
  h = await startAdminHarness("fix-trans-session-ttl", { SESSION_TTL: `${BOOT_TTL_SECONDS}s` });
}, 30_000);
afterAll(async () => { await h.close(); });

let ip = 0;
async function issued(viaChangePassword = false): Promise<{ maxAge: number | undefined; lifetime: number }> {
  const res = viaChangePassword
    ? await h.as(await h.login("admin", ADMIN_PASSWORD), { method: "POST", url: "/change-password", payload: { newPassword: ADMIN_PASSWORD, currentPassword: ADMIN_PASSWORD } })
    : await h.app.inject({ method: "POST", url: "/admin/api/login", payload: { username: "admin", password: ADMIN_PASSWORD }, remoteAddress: `10.98.0.${++ip}` });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((k) => k.name === "hydrogen_session")!;
  const decoded = jwt.decode(cookie.value) as { iat: number; exp: number };
  return { maxAge: cookie.maxAge, lifetime: decoded.exp - decoded.iat };
}

describe("T4: the runtime session TTL setting governs new sessions", () => {
  it("uses the boot-time value while the setting is unset", async () => {
    expect(await issued()).toEqual({ maxAge: BOOT_TTL_SECONDS, lifetime: BOOT_TTL_SECONDS });
  });

  it("uses the saved value for the next login and the next password change", async () => {
    const put = await h.admin({ method: "PUT", url: "/settings/env", payload: { sessionTtlMs: 120_000 } });
    expect(put.statusCode).toBe(200);
    expect(put.json().sessionTtlMs).toBe(120_000);
    expect(await issued()).toEqual({ maxAge: 120, lifetime: 120 });
    expect(await issued(true)).toEqual({ maxAge: 120, lifetime: 120 });
  });
});
