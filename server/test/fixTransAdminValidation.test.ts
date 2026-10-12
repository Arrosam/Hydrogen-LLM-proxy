/**
 * Admin-route validation fixes.
 * T5  — a provider baseUrl that is not a URL is a 400, not a thrown 500.
 * T14 — a too-short password on a user update names the rule, as create does.
 * T1  — the allowlist validator refuses a CIDR with an empty or malformed
 *       prefix length (which used to be stored and read back as /0).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;
beforeAll(async () => { h = await startAdminHarness("fix-trans-admin-validation"); }, 30_000);
afterAll(async () => { await h.close(); });

describe("T5: a provider baseUrl that is not a URL is refused with 400", () => {
  const NOT_URLS = ["not a url", "", "example.com/v1"];
  let providerId = 0;
  beforeAll(() => {
    providerId = h.c.providers.create({ name: "p", type: "openai_completion", baseUrl: "https://api.example.com/v1", apiKey: "k" }).id;
  });

  for (const baseUrl of NOT_URLS) {
    it(`create / patch / test / altEndpoints with ${JSON.stringify(baseUrl)}`, async () => {
      const calls = [
        h.admin({ method: "POST", url: "/providers", payload: { name: "x", type: "openai_completion", baseUrl } }),
        h.admin({ method: "PATCH", url: `/providers/${providerId}`, payload: { baseUrl } }),
        h.admin({ method: "POST", url: "/providers/test", payload: { type: "openai_completion", baseUrl } }),
        h.admin({ method: "POST", url: "/providers", payload: { name: "y", type: "openai_completion", baseUrl: "https://ok.example.com", altEndpoints: [{ type: "anthropic", baseUrl }] } }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(/baseUrl: Invalid url/);
      }
    });
  }

  it("a well-formed URL with another scheme keeps its own message", async () => {
    const res = await h.admin({ method: "POST", url: "/providers", payload: { name: "z", type: "openai_completion", baseUrl: "ftp://example.com" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("baseUrl: baseUrl must use http or https");
  });
});

describe("T14: UserUpdate.password states the minimum length like UserCreate", () => {
  it("PATCH /users/:id with a short password", async () => {
    const created = await h.admin({ method: "POST", url: "/users", payload: { username: "u1", password: "short" } });
    expect(created.statusCode).toBe(400);
    const user = await h.c.users.create({ username: "u2", password: "long-enough-password", role: "manager", enabled: true });
    const patched = await h.admin({ method: "PATCH", url: `/users/${user.id}`, payload: { password: "short" } });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error).toBe(created.json().error);
    expect(patched.json().error).toBe("password: password must be at least 8 characters");
  });
});

describe("T1: the upstream allowlist refuses malformed CIDR entries", () => {
  const put = (entries: string[]) => h.admin({ method: "PUT", url: "/settings/upstream-allowlist", payload: { entries } });

  it.each(["10.0.0.0/", "10.0.0.0/8/9", "10.0.0.0/ 8", "10.0.0.0/0x8", "10.0.0.0/1e1", "10.0.0.0/8.0", "10.0.0.0/+8", "10.0.0.0/33", "::1/128"])("%j is a 400 and nothing is stored", async (entry) => {
    const before = h.c.settings.allowlist();
    const res = await put(["ok.example.com", entry]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(`invalid entries (use IP, v4 CIDR, or hostname): ${entry}`);
    expect(h.c.settings.allowlist()).toEqual(before);
  });

  it("well-formed entries are still accepted, trimmed and de-duplicated", async () => {
    const res = await put(["10.0.0.0/8", " 10.0.0.0/8 ", "192.168.1.0/0", "192.168.1.7/32", "203.0.113.9", "::1", "api.example.com", ".example.com"]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: ["10.0.0.0/8", "192.168.1.0/0", "192.168.1.7/32", "203.0.113.9", "::1", "api.example.com", ".example.com"] });
  });
});
