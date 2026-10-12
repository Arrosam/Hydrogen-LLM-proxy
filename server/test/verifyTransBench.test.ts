/**
 * Independent verification (spec section TRANS): T3, T12.
 *
 * Written from the verification spec only. The app is booted whole; bench runs
 * go through Fastify's inject, and the response-header checks of T3 also go
 * over a real loopback socket (inject cannot tell a header the route set from
 * one Node added on its own).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

let h: AdminHarness;
let upstream: FakeUpstream;
let port = 0;
let serviceId = 0;
let apiKey = "";
const script: UpstreamBehavior[] = [];

beforeAll(async () => {
  upstream = await startFakeUpstream({ text: "pong", script });
  h = await startAdminHarness("verify-trans-bench", { ALLOW_PRIVATE_UPSTREAMS: "1", LOG_PAYLOAD_MAX_CHARS: "0" });
  const provider = h.c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = h.c.models.create({ name: "m" });
  h.c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  // A model that exists but is not mapped to the provider.
  h.c.models.create({ name: "unmapped" });
  serviceId = h.c.services.create({ name: "svc", definition: { timeoutMs: 30_000, steps: [{ model: "m", provider: "fake" }] } as never }).id;
  apiKey = h.c.tokens.create({ name: "client" }).secret;
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  port = (h.app.server.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
  await h.close();
  await upstream.close();
});

const RAW = { kind: "raw", model: "m", provider: "fake", providerFormat: "openai_completion" };
const chatBody = (stream: boolean) => ({ model: "x", stream, messages: [{ role: "user", content: "hi" }] });
const bench = (target: unknown, stream: boolean) =>
  h.admin({ method: "POST", url: "/bench/chat", payload: { target, ingress: "openai_completion", body: chatBody(stream) } });
/** Script the upstream's next attempt. */
const next = (behavior: UpstreamBehavior): void => { script[upstream.requests] = behavior; };

/** The payload of the trailing `bench` frame of a streamed run. */
function benchFrame(payload: string): Record<string, unknown> {
  const frames = payload.split("\n\n").filter((f) => f.trim() !== "" && f.startsWith("event: bench"));
  expect(frames).toHaveLength(1);
  const data = frames[0].split("\n").find((l) => l.startsWith("data:"))!;
  return JSON.parse(data.slice(5)) as Record<string, unknown>;
}

interface WireResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Every header NAME as sent, lowercased, duplicates kept. */
  names: string[];
  body: string;
}

/** One POST over a real socket, asking the server to close the connection afterwards. */
function overSocket(path: string, headers: Record<string, string>, payload: unknown): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, agent: false,
        headers: { "content-type": "application/json", "content-length": String(body.length), connection: "close", ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          names: res.rawHeaders.filter((_v, i) => i % 2 === 0).map((n) => n.toLowerCase()),
          body: text,
        }));
        res.on("error", reject);
      });
    req.on("error", reject);
    req.end(body);
  });
}

const benchOverSocket = (target: unknown): Promise<WireResponse> =>
  overSocket("/admin/api/bench/chat", { cookie: h.adminCookie }, { target, ingress: "openai_completion", body: chatBody(true) });
const proxyOverSocket = (): Promise<WireResponse> =>
  overSocket("/v1/chat/completions", { authorization: `Bearer ${apiKey}` }, { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] });

// ---------------------------------------------------------------------------
// T3 — the bench's streamed run uses the proxy's SSE headers
// ---------------------------------------------------------------------------

describe("T3: streamed bench run response headers", () => {
  const TARGETS: Array<[string, () => unknown]> = [
    ["a raw tuple", () => RAW],
    ["a saved service", () => ({ kind: "service", serviceId })],
  ];

  it.each(TARGETS)("%s: content type is the SSE content type with its charset", async (_label, target) => {
    const res = await bench(target(), true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(SSE_CONTENT_TYPE);
    expect(benchFrame(res.body).ok).toBe(true);
  });

  it("the bench's content type is the very one the proxy's own stream answers with", async () => {
    const [viaBench, viaProxy] = [await benchOverSocket(RAW), await proxyOverSocket()];
    expect(viaProxy.status).toBe(200);
    expect(viaProxy.headers["content-type"]).toBe(SSE_CONTENT_TYPE);
    expect(viaBench.status).toBe(200);
    expect(viaBench.headers["content-type"]).toBe(viaProxy.headers["content-type"]);
  });

  it.each(TARGETS)("%s: the route does not force `connection: keep-alive` (a client that asked to close gets close)", async (_label, target) => {
    const res = await benchOverSocket(target());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(SSE_CONTENT_TYPE);
    expect(String(res.headers.connection ?? "").toLowerCase()).not.toContain("keep-alive");
    // Not sent twice either (once by the route, once by Node).
    expect(res.names.filter((n) => n === "connection").length).toBeLessThanOrEqual(1);
    expect(benchFrame(res.body).ok).toBe(true);
  });

  it("the connection header matches what the proxy's own stream sends to the same client", async () => {
    const [viaBench, viaProxy] = [await benchOverSocket(RAW), await proxyOverSocket()];
    expect(viaBench.headers.connection).toBe(viaProxy.headers.connection);
  });

  it("a streamed run that fails still answers with the SSE content type and no forced keep-alive", async () => {
    next({ kind: "status", status: 500, body: { error: { message: "boom" } } });
    const res = await benchOverSocket(RAW);
    expect(res.headers["content-type"]).toBe(SSE_CONTENT_TYPE);
    expect(String(res.headers.connection ?? "").toLowerCase()).not.toContain("keep-alive");
    expect(benchFrame(res.body).ok).toBe(false);
  });

  it("unchanged: a buffered bench run answers JSON, not an event stream", async () => {
    const res = await bench(RAW, false);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/json");
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T12 — an unresolvable raw target reports 502, buffered and streamed alike
// ---------------------------------------------------------------------------

describe("T12: raw bench target that fails to resolve", () => {
  const UNRESOLVABLE: Array<[string, Record<string, unknown>]> = [
    ["no such mapping (unknown model)", { ...RAW, model: "ghost" }],
    ["no such mapping (model exists, not mapped to the provider)", { ...RAW, model: "unmapped" }],
    ["no such mapping (unknown provider)", { ...RAW, provider: "ghost" }],
    ["no endpoint for the family (anthropic)", { ...RAW, providerFormat: "anthropic" }],
    ["no endpoint for the family (openai_responses)", { ...RAW, providerFormat: "openai_responses" }],
  ];

  it.each(UNRESOLVABLE)("%s: buffered and streamed runs both report status 502", async (_label, target) => {
    const before = upstream.requests;

    const buffered = (await bench(target, false)).json() as { ok?: boolean; status?: number };
    expect(buffered.ok).toBe(false);
    expect(buffered.status).toBe(502);

    const streamedRes = await bench(target, true);
    const streamed = benchFrame(streamedRes.body);
    expect(streamed.ok).toBe(false);
    expect(streamed.status).toBe(502);

    expect(streamed.status).toBe(buffered.status);
    expect(upstream.requests - before).toBe(0); // nothing was misrouted to the upstream
  });

  it("unchanged: a raw target that resolves reports 200 in both modes", async () => {
    const buffered = (await bench(RAW, false)).json() as { ok: boolean; status: number };
    expect(buffered).toMatchObject({ ok: true, status: 200 });
    const streamed = benchFrame((await bench(RAW, true)).body);
    expect(streamed).toMatchObject({ ok: true, status: 200 });
  });

  it("unchanged: an upstream refusal keeps the upstream's own status in both modes (not flattened to 502)", async () => {
    next({ kind: "status", status: 429, body: { error: { message: "slow down" } } });
    const buffered = (await bench(RAW, false)).json() as { ok: boolean; status: number };
    expect(buffered).toMatchObject({ ok: false, status: 429 });

    next({ kind: "status", status: 429, body: { error: { message: "slow down" } } });
    const streamed = benchFrame((await bench(RAW, true)).body);
    expect(streamed).toMatchObject({ ok: false, status: 429 });
  });
});
