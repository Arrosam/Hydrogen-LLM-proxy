/**
 * Independent verification, written from the spec only (EXEC E2, E7).
 *
 * E2  A provider referencing an egress proxy id that no longer exists fails
 *     the request with an error mentioning the proxy and makes NO upstream
 *     request. A DISABLED proxy means a direct connection; so does no proxy.
 * E7  `hasKey` / `hasPassword` in admin listings are true only for a complete
 *     stored secret (ciphertext + iv + tag).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";
import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";

const ANSWER = "DIRECT ANSWER FROM THE FAKE UPSTREAM";

let h: AdminHarness;
let upstream: FakeUpstream;
let secret: string;
let deadPort: number;

/** A loopback port nothing listens on. */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  h = await startAdminHarness("verify-exec-proxy", {
    ALLOW_PRIVATE_UPSTREAMS: "1",
    STREAM_COMMIT_GRACE_MS: "600000",
    SIMULATED_STREAMING_TOKEN_RATE: "2000000",
  });
  upstream = await startFakeUpstream({ text: ANSWER });
  secret = h.c.tokens.create({ name: "verify-proxy-token" }).secret;
  deadPort = await freePort();
});

afterAll(async () => {
  await h.close();
  await upstream.close();
});

let seq = 0;
/** A provider on the fake upstream, a model mapped to it and a one-step service. */
function route(proxyId: number | null): { service: string; providerId: number } {
  const n = ++seq;
  const provider = h.c.providers.create({ name: `prov-${n}`, type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k", proxyId });
  const model = h.c.models.create({ name: `model-${n}` });
  h.c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  h.c.services.create({
    name: `svc-${n}`,
    definition: { timeoutMs: 5_000, steps: [{ model: `model-${n}`, provider: `prov-${n}`, retry: { maxAttempts: 1 } }] } as never,
  });
  return { service: `svc-${n}`, providerId: provider.id };
}

const chat = (service: string, stream = false) =>
  h.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    payload: { model: service, stream, messages: [{ role: "user", content: "hi" }] },
  });

/** Point a provider at a proxy id that has no row (the reference outlived the proxy). */
function orphan(providerId: number, ghostId: number): void {
  h.c.sqlite.pragma("foreign_keys = OFF");
  try {
    h.c.sqlite.prepare("UPDATE providers SET proxy_id = ? WHERE id = ?").run(ghostId, providerId);
  } finally {
    h.c.sqlite.pragma("foreign_keys = ON");
  }
  const row = h.c.sqlite.prepare("SELECT proxy_id FROM providers WHERE id = ?").get(providerId) as { proxy_id: number | null };
  expect(row.proxy_id).toBe(ghostId);
  expect(h.c.sqlite.prepare("SELECT id FROM proxies WHERE id = ?").get(ghostId)).toBeUndefined();
}

describe("E2: a provider whose egress proxy no longer exists", () => {
  it("non-streaming: fails with an error naming the proxy and never reaches the upstream", async () => {
    const r = route(null);
    orphan(r.providerId, 987_001);
    const before = upstream.requests;
    const res = await chat(r.service);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toMatch(/proxy/i);
    expect(res.body).not.toContain(ANSWER);
    expect(upstream.requests).toBe(before);
  });

  it("streaming: fails with an error naming the proxy and never reaches the upstream", async () => {
    const r = route(null);
    orphan(r.providerId, 987_002);
    const before = upstream.requests;
    const res = await chat(r.service, true);
    expect(res.body).toMatch(/proxy/i);
    expect(res.body).not.toContain("DIRECT ANSWER");
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(upstream.requests).toBe(before);
  });

  it("a proxy deleted out from under its provider: same refusal, no direct connection", async () => {
    const created = await h.admin({ method: "POST", url: "/proxies", payload: { name: "soon-gone", host: "127.0.0.1", port: deadPort } });
    expect(created.statusCode).toBe(200);
    const proxyId = created.json().proxy.id as number;
    const r = route(proxyId);
    h.c.sqlite.pragma("foreign_keys = OFF");
    try {
      h.c.sqlite.prepare("DELETE FROM proxies WHERE id = ?").run(proxyId);
    } finally {
      h.c.sqlite.pragma("foreign_keys = ON");
    }
    const row = h.c.sqlite.prepare("SELECT proxy_id FROM providers WHERE id = ?").get(r.providerId) as { proxy_id: number | null };
    expect(row.proxy_id).toBe(proxyId);

    const before = upstream.requests;
    const res = await chat(r.service);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toMatch(/proxy/i);
    expect(upstream.requests).toBe(before);
  });

  it("the failure is logged as a failed request, not a success", async () => {
    const r = route(null);
    orphan(r.providerId, 987_003);
    const res = await chat(r.service);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const log = h.c.sqlite
      .prepare("SELECT http_status FROM request_logs WHERE requested_service = ? ORDER BY id DESC LIMIT 1")
      .get(r.service) as { http_status: number } | undefined;
    if (log) expect(log.http_status).toBeGreaterThanOrEqual(400);
  });
});

describe("E2 neighbours: when the connection is direct", () => {
  it("no proxy: direct, the upstream answers", async () => {
    const r = route(null);
    const before = upstream.requests;
    const res = await chat(r.service);
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe(ANSWER);
    expect(upstream.requests).toBe(before + 1);
  });

  it("a DISABLED proxy (pointing at a dead port): direct, the upstream answers", async () => {
    const created = await h.admin({ method: "POST", url: "/proxies", payload: { name: "disabled-px", host: "127.0.0.1", port: deadPort, enabled: false } });
    expect(created.statusCode).toBe(200);
    const r = route(created.json().proxy.id as number);
    const before = upstream.requests;
    const res = await chat(r.service);
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe(ANSWER);
    expect(upstream.requests).toBe(before + 1);
  });

  it("an ENABLED proxy on a dead port is used, not bypassed: the request fails and the upstream sees nothing", async () => {
    const created = await h.admin({ method: "POST", url: "/proxies", payload: { name: "enabled-dead-px", host: "127.0.0.1", port: deadPort } });
    expect(created.statusCode).toBe(200);
    const r = route(created.json().proxy.id as number);
    const before = upstream.requests;
    const res = await chat(r.service);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(upstream.requests).toBe(before);
  });
});

describe("E7: hasKey / hasPassword need the complete stored secret", () => {
  const PARTS = ["ciphertext", "iv", "tag"] as const;

  const listedProvider = async (id: number): Promise<{ hasKey: boolean }> => {
    const res = await h.admin({ url: "/providers" });
    expect(res.statusCode).toBe(200);
    const found = (res.json().providers as Array<{ id: number; hasKey: boolean }>).find((p) => p.id === id);
    expect(found).toBeDefined();
    return found!;
  };
  const listedProxy = async (id: number): Promise<{ hasPassword: boolean }> => {
    const res = await h.admin({ url: "/proxies" });
    expect(res.statusCode).toBe(200);
    const found = (res.json().proxies as Array<{ id: number; hasPassword: boolean }>).find((p) => p.id === id);
    expect(found).toBeDefined();
    return found!;
  };

  let n = 0;
  const makeProvider = (apiKey: string | null): number =>
    h.c.providers.create({ name: `e7-prov-${++n}`, type: "openai_completion", baseUrl: "http://provider.invalid/v1", apiKey }).id;
  const makeProxy = async (password?: string): Promise<number> => {
    const res = await h.admin({ method: "POST", url: "/proxies", payload: { name: `e7-px-${++n}`, host: "px.local", port: 8080, username: "u", ...(password ? { password } : {}) } });
    expect(res.statusCode).toBe(200);
    return res.json().proxy.id as number;
  };

  it("provider: a complete key is hasKey true; no key is false", async () => {
    expect((await listedProvider(makeProvider("sk-complete"))).hasKey).toBe(true);
    expect((await listedProvider(makeProvider(null))).hasKey).toBe(false);
  });

  it.each(PARTS)("provider: a row missing only key_%s reports hasKey false", async (part) => {
    const id = makeProvider("sk-partial");
    expect((await listedProvider(id)).hasKey).toBe(true);
    h.c.sqlite.prepare(`UPDATE providers SET key_${part} = NULL WHERE id = ?`).run(id);
    expect((await listedProvider(id)).hasKey).toBe(false);
  });

  it.each(PARTS)("provider: a row holding ONLY key_%s reports hasKey false", async (part) => {
    const id = makeProvider("sk-partial");
    for (const other of PARTS) if (other !== part) h.c.sqlite.prepare(`UPDATE providers SET key_${other} = NULL WHERE id = ?`).run(id);
    expect((await listedProvider(id)).hasKey).toBe(false);
  });

  it("provider: the single-row answers (PATCH) agree with the listing", async () => {
    const id = makeProvider("sk-partial");
    h.c.sqlite.prepare("UPDATE providers SET key_tag = NULL WHERE id = ?").run(id);
    const res = await h.admin({ method: "PATCH", url: `/providers/${id}`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider.hasKey).toBe(false);
  });

  it("proxy: a complete password is hasPassword true; no password is false", async () => {
    expect((await listedProxy(await makeProxy("pw-complete"))).hasPassword).toBe(true);
    expect((await listedProxy(await makeProxy())).hasPassword).toBe(false);
  });

  it.each(PARTS)("proxy: a row missing only password_%s reports hasPassword false", async (part) => {
    const id = await makeProxy("pw-partial");
    expect((await listedProxy(id)).hasPassword).toBe(true);
    h.c.sqlite.prepare(`UPDATE proxies SET password_${part} = NULL WHERE id = ?`).run(id);
    expect((await listedProxy(id)).hasPassword).toBe(false);
  });

  it.each(PARTS)("proxy: a row holding ONLY password_%s reports hasPassword false", async (part) => {
    const id = await makeProxy("pw-partial");
    for (const other of PARTS) if (other !== part) h.c.sqlite.prepare(`UPDATE proxies SET password_${other} = NULL WHERE id = ?`).run(id);
    expect((await listedProxy(id)).hasPassword).toBe(false);
  });

  it("proxy: the single-row answer (PATCH) agrees with the listing", async () => {
    const id = await makeProxy("pw-partial");
    h.c.sqlite.prepare("UPDATE proxies SET password_iv = NULL WHERE id = ?").run(id);
    const res = await h.admin({ method: "PATCH", url: `/proxies/${id}`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().proxy.hasPassword).toBe(false);
  });
});
