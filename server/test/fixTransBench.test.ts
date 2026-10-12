/**
 * T3 — the bench's streamed run opens its response with the proxy's shared SSE
 * setup: no forced `connection: keep-alive` (the framing regression pinned by
 * streamIntegrity.test.ts) and a hijacked reply.
 * T12 — a raw tuple that fails to resolve reports the same status whether the
 * run is buffered or streamed.
 */
import net, { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";
import { SSE_HEADERS } from "../src/transport/keepalive";

let h: AdminHarness;
let upstream: FakeUpstream;

beforeAll(async () => {
  upstream = await startFakeUpstream({ text: "pong" });
  h = await startAdminHarness("fix-trans-bench", { ALLOW_PRIVATE_UPSTREAMS: "1" });
  const provider = h.c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = h.c.models.create({ name: "m" });
  h.c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
}, 30_000);

afterAll(async () => {
  await h.close();
  await upstream.close();
});

const RAW = { kind: "raw", model: "m", provider: "fake", providerFormat: "openai_completion" };
const chat = (target: unknown, stream: boolean) =>
  h.admin({ method: "POST", url: "/bench/chat", payload: { target, ingress: "openai_completion", body: { model: "x", stream, messages: [{ role: "user", content: "hi" }] } } });
const benchReport = (body: string): { status: number; ok: boolean } =>
  JSON.parse(body.slice(body.lastIndexOf("event: bench")).split("\n")[1].slice("data: ".length)) as { status: number; ok: boolean };

/** One raw request on a real socket, so the response head is the one Node
 * actually frames (inject cannot show it). */
function rawStreamedRun(port: number, httpVersion: "1.0" | "1.1"): Promise<{ head: string; body: string }> {
  const payload = JSON.stringify({ target: RAW, ingress: "openai_completion", body: { model: "x", stream: true, messages: [{ role: "user", content: "hi" }] } });
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let raw = "";
    const done = (): void => {
      sock.destroy();
      const split = raw.indexOf("\r\n\r\n");
      resolve({ head: raw.slice(0, split), body: raw.slice(split + 4) });
    };
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(
        `POST /admin/api/bench/chat HTTP/${httpVersion}\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `Cookie: ${h.adminCookie}\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
      );
    });
    sock.on("data", (chunk: string) => {
      raw += chunk;
      if (httpVersion === "1.1" && raw.includes("\r\n0\r\n\r\n")) done();
    });
    sock.on("close", done);
    sock.on("error", reject);
    setTimeout(done, 10_000).unref();
  });
}

describe("T3: streamed bench run uses the shared SSE setup", () => {
  it("sends the proxy's SSE header set", async () => {
    const res = await chat(RAW, true);
    expect(res.statusCode).toBe(200);
    for (const [name, value] of Object.entries(SSE_HEADERS)) expect(res.headers[name]).toBe(value);
    expect(res.body).toContain("[DONE]");
    expect(benchReport(res.body)).toMatchObject({ ok: true, status: 200 });
  });

  it("tells an HTTP/1.0 peer to read to close, never claiming keep-alive without a length", async () => {
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const { head, body } = await rawStreamedRun((h.app.server.address() as AddressInfo).port, "1.0");
    const lower = head.toLowerCase();
    expect(lower).not.toContain("transfer-encoding: chunked");
    expect(lower).not.toContain("content-length:");
    expect(lower).toContain("connection: close");
    expect(lower).not.toContain("connection: keep-alive");
    expect(body).toContain("event: bench");
  }, 30_000);
});

describe("T12: an unresolvable raw tuple reports one status, buffered or streamed", () => {
  for (const [name, target] of [
    ["no such endpoint", { ...RAW, providerFormat: "anthropic" }],
    ["no such mapping", { ...RAW, model: "ghost" }],
  ] as const) {
    it(name, async () => {
      const buffered = JSON.parse((await chat(target, false)).body) as { status: number; ok: boolean };
      const streamed = benchReport((await chat(target, true)).body);
      expect(buffered).toMatchObject({ ok: false, status: 502 });
      expect(streamed).toMatchObject({ ok: false, status: buffered.status });
    });
  }
});
