import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { stepOverrides, type ServiceStep } from "../src/execution/definition";
// Side-effect import: registers all three wire formats with the format registry.
import "../src/core/format";
import { buildRequest } from "../src/core/format/registry";
import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";
import { parseService } from "../src/execution/definition";

describe("stream override reproduction", () => {
  it("parseService preserves a stream override through the zod schema", () => {
    const def = parseService({
      steps: [{ model: "m", provider: "fake", overrides: { stream: true, topP: 0.9 } }],
    });
    const steps = def as { steps: Array<{ overrides?: Record<string, unknown> }> };
    expect(steps.steps[0].overrides?.stream).toBe(true);
    expect(steps.steps[0].overrides?.topP).toBe(0.9);
  });

  it("step overrides with stream:true should set request.stream to true", () => {
    const step: ServiceStep = {
      model: "m",
      provider: "fake",
      overrides: { stream: true } as never,
    };
    const ov = stepOverrides(step);
    expect(ov?.stream).toBe(true);
  });

  it("step overrides with stream:false should set request.stream to false", () => {
    const step: ServiceStep = {
      model: "m",
      provider: "fake",
      overrides: { stream: false } as never,
    };
    const ov = stepOverrides(step);
    expect(ov?.stream).toBe(false);
  });

  it("a non-streaming request with stream:true override should render stream:true in wire body", () => {
    const base = buildRequest("openai_completion", {
      requestedService: "svc",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      params: {},
      stream: false,
    });
    const step: ServiceStep = {
      model: "m",
      provider: "fake",
      overrides: { stream: true } as never,
    };
    const merged = base.withOverrides(stepOverrides(step));
    expect(merged.stream).toBe(true);

    const rendered = merged.render({ upstreamModel: "up" });
    expect(rendered.stream).toBe(true);
    expect(rendered.stream_options).toEqual({ include_usage: true });
  });

  it("a streaming request with stream:false override should render without stream in wire body", () => {
    const base = buildRequest("openai_completion", {
      requestedService: "svc",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      params: {},
      stream: true,
    });
    const step: ServiceStep = {
      model: "m",
      provider: "fake",
      overrides: { stream: false } as never,
    };
    const merged = base.withOverrides(stepOverrides(step));
    expect(merged.stream).toBe(false);

    const rendered = merged.render({ upstreamModel: "up" });
    expect(rendered.stream).toBeUndefined();
  });
});

// --- end-to-end: does an override stream:true turn the upstream call into a stream? ---

interface Harness {
  app: FastifyInstance;
  upstream: FakeUpstream;
  port: number;
  secret: string;
  dataDir: string;
  sqlite: { close: () => void };
}

let harness: Harness | null = null;

afterEach(async () => {
  if (!harness) return;
  await harness.app.close();
  await harness.upstream.close();
  harness.sqlite.close();
  fs.rmSync(harness.dataDir, { recursive: true, force: true });
  harness = null;
});

async function boot(definition: unknown, script: UpstreamBehavior[]): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-stream-ov-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "stream-ov-test-password";
  process.env.SESSION_SECRET = "stream-ov-test-session-secret";
  process.env.SIMULATED_STREAMING_TOKEN_RATE = "2000000";
  process.env.STREAM_COMMIT_GRACE_MS = "600000";

  const upstream = await startFakeUpstream({ text: "ANSWER", chunkChars: 200, script, ttfbMs: 50 });

  const { boot: bootContainer } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await bootContainer();

  const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = c.models.create({ name: "m" });
  c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  c.services.create({ name: "svc", definition: definition as never });
  const { secret } = c.tokens.create({ name: "t" });

  const app = await buildApp(c);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;

  harness = { app, upstream, port, secret, dataDir, sqlite: c.sqlite as never };
  return harness;
}

function call(port: number, secret: string, stream: boolean): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model: "svc", stream, messages: [{ role: "user", content: "hi" }] }));
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("end-to-end: override stream on the upstream call", () => {
  it("client streams=false, step override stream=true -> upstream receives stream:true and SSE", async () => {
    const def = {
      timeoutMs: 30_000,
      steps: [{ model: "m", provider: "fake", overrides: { stream: true } }],
    };
    const h = await boot(def, [{ kind: "ok" }]);

    // Client requests a NON-streaming answer.
    const got = await call(h.port, h.secret, false);

    expect(got.status).toBe(200);
    expect(got.body).toContain("ANSWER");

    // The upstream must have seen stream:true in the request body.
    const sent = h.upstream.bodies[0] as { stream?: unknown };
    expect(sent.stream).toBe(true);
  }, 30_000);

  it("client streams=false, step override stream=false -> upstream receives no stream flag", async () => {
    const def = {
      timeoutMs: 30_000,
      steps: [{ model: "m", provider: "fake", overrides: { stream: false } }],
    };
    const h = await boot(def, [{ kind: "ok" }]);

    const got = await call(h.port, h.secret, false);

    expect(got.status).toBe(200);
    expect(got.body).toContain("ANSWER");

    const sent = h.upstream.bodies[0] as { stream?: unknown };
    expect(sent.stream).toBeUndefined();
  }, 30_000);
});
