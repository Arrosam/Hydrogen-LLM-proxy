/**
 * End-to-end: allowlisted client feature headers reach same-family upstreams
 * (roadmap F1), and unsupportable params are rejected honestly (F16).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";

let app: FastifyInstance;
let upstream: FakeUpstream;
let port = 0;
let secret = "";
let dataDir = "";
let sqlite: { close: () => void };

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-fwd-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.ADMIN_PASSWORD = "forwarding-test-password";
  process.env.SESSION_SECRET = "forwarding-test-session-secret";

  upstream = await startFakeUpstream({ text: "pong" });

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await boot();
  const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = c.models.create({ name: "m" });
  c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  c.services.create({ name: "svc", definition: { timeoutMs: 30_000, steps: [{ model: "m", provider: "fake" }] } as never });
  secret = c.tokens.create({ name: "t" }).secret;
  sqlite = c.sqlite as never;

  app = await buildApp(c);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
  await app.close();
  await upstream.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, ...headers },
    body: JSON.stringify(body),
  });
}

describe("F1: client feature headers forward to same-family upstreams", () => {
  it("carries allowlisted headers and never the client's authorization", async () => {
    const r = await post(
      { model: "svc", stream: false, messages: [{ role: "user", content: "hi" }] },
      { "x-title": "My App", "http-referer": "https://example.test", "anthropic-beta": "should-not-cross" },
    );
    expect(r.status).toBe(200);
    const seen = upstream.headers[upstream.headers.length - 1];
    expect(seen["x-title"]).toBe("My App");
    expect(seen["http-referer"]).toBe("https://example.test");
    // anthropic-beta is not on the OpenAI-family allowlist.
    expect(seen["anthropic-beta"]).toBeUndefined();
    // The provider's own key, never the client's proxy token.
    expect(seen["authorization"]).toBe("Bearer k");
  });
});

describe("F16: unsupportable params are rejected, not narrowed", () => {
  it("n > 1 gets an explicit 400 instead of a silent choices[0]", async () => {
    const r = await post({ model: "svc", n: 3, stream: false, messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { message: string } };
    expect(body.error.message).toContain("n > 1");
  });
});
