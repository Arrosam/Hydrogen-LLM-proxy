/**
 * The OCR dry-run endpoint: one test image through an OCR config, returning
 * the model's raw reply plus the parsed description the stages would see.
 * Resolution must mirror the Micro Agent pre-pass (service reference or inline
 * steps, never an agent), and the editor's unsaved prompt must be honored.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";

// A 1x1 transparent PNG.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const ADMIN_PASSWORD = "ocr-test-admin-pass";

let app: FastifyInstance;
let upstream: FakeUpstream;
let sqlite: { close: () => void };
let dataDir: string;
let cookie: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-ocrtest-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SESSION_SECRET = "ocr-test-session-secret-0123456789";

  upstream = await startFakeUpstream({ text: "plain answer", ocrText: (i) => `OCR TEXT ${i + 1}` });

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await boot();

  const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = c.models.create({ name: "vision-m" });
  c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  c.services.create({ name: "vision", definition: { timeoutMs: 30_000, steps: [{ model: "vision-m", provider: "fake" }] } as never });
  c.services.create({
    name: "an-agent",
    definition: { kind: "micro_agent", timeoutMs: 30_000, stages: [{ name: "only", input: [], service: "vision" }] } as never,
  });
  sqlite = c.sqlite;

  app = await buildApp(c);
  const res = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: "admin", password: ADMIN_PASSWORD } });
  const session = res.cookies.find((k) => k.name === "hydrogen_session")!;
  cookie = `${session.name}=${session.value}`;
});

afterAll(async () => {
  await app.close();
  await upstream.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const testOcr = (payload: unknown) =>
  app.inject({ method: "POST", url: "/admin/api/services/test-ocr", payload: payload as never, headers: { cookie } });

const IMAGE = { mediaType: "image/png", data: TINY_PNG };

describe("POST /services/test-ocr", () => {
  it("runs the test image through a referenced service and parses the description", async () => {
    const before = upstream.ocrRequests;
    const res = await testOcr({ ocr: { service: "vision" }, image: IMAGE });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean; description: string; raw: string;
      served: { model: string; provider: string }; latencyMs: number;
      usage: { totalTokens: number };
    };
    expect(body.ok).toBe(true);
    expect(body.description).toBe("OCR TEXT 1");
    expect(body.raw).toContain('"index":1');
    expect(body.served).toEqual({ model: "vision-m", provider: "fake" });
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.usage.totalTokens).toBe(3);
    expect(upstream.ocrRequests).toBe(before + 1); // the image actually reached the model
  });

  it("honors the editor's (unsaved) custom prompt", async () => {
    const res = await testOcr({ ocr: { service: "vision", prompt: "CUSTOM OCR PROMPT 42" }, image: IMAGE });
    expect(res.statusCode).toBe(200);
    const sent = JSON.stringify(upstream.bodies[upstream.bodies.length - 1]);
    expect(sent).toContain("CUSTOM OCR PROMPT 42");
  });

  it("runs legacy inline steps too", async () => {
    const res = await testOcr({ ocr: { steps: [{ model: "vision-m", provider: "fake" }] }, image: IMAGE });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { description: string }).description).toBe("OCR TEXT 1");
  });

  it("rejects a config with no model, an unknown service, and an agent reference", async () => {
    expect((await testOcr({ ocr: {}, image: IMAGE })).statusCode).toBe(400);
    expect((await testOcr({ ocr: { service: "ghost" }, image: IMAGE })).statusCode).toBe(400);
    const agent = await testOcr({ ocr: { service: "an-agent" }, image: IMAGE });
    expect(agent.statusCode).toBe(400);
    expect((agent.json() as { error: string }).error).toContain("must be a Model Service");
  });

  it("rejects a missing or non-image payload", async () => {
    expect((await testOcr({ ocr: { service: "vision" } })).statusCode).toBe(400);
    expect((await testOcr({ ocr: { service: "vision" }, image: { mediaType: "text/plain", data: "eA==" } })).statusCode).toBe(400);
  });
});
