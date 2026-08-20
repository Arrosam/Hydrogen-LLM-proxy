/**
 * Fuzzy endpoint adapter: sloppy client base URLs still reach the service.
 * Unit-tests the pure mapper, then proves the wiring end-to-end over a real
 * socket (doubled slash, missing /v1, bare /v1 with an Anthropic client).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { fuzzyRewriteUrl } from "../src/transport/fuzzyUrl";
import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";

describe("fuzzyRewriteUrl", () => {
  const h = {};
  const anthH = { "anthropic-version": "2023-06-01" };

  it("collapses doubled slashes onto known routes", () => {
    expect(fuzzyRewriteUrl("POST", "//v1/messages", h)).toBe("/v1/messages");
    expect(fuzzyRewriteUrl("POST", "/v1//chat//completions", h)).toBe("/v1/chat/completions");
  });

  it("restores a missing /v1 prefix from the endpoint suffix", () => {
    expect(fuzzyRewriteUrl("POST", "/completions", h)).toBe("/v1/chat/completions");
    expect(fuzzyRewriteUrl("POST", "/chat/completions", h)).toBe("/v1/chat/completions");
    expect(fuzzyRewriteUrl("POST", "/messages", h)).toBe("/v1/messages");
    expect(fuzzyRewriteUrl("POST", "/api/v1/responses", h)).toBe("/v1/responses");
    expect(fuzzyRewriteUrl("GET", "/models", h)).toBe("/v1/models");
  });

  it("tolerates singular typos", () => {
    expect(fuzzyRewriteUrl("POST", "/v1/message", h)).toBe("/v1/messages");
    expect(fuzzyRewriteUrl("POST", "/v1/chat/completion", h)).toBe("/v1/chat/completions");
  });

  it("routes a bare base URL by sniffing the wire family", () => {
    expect(fuzzyRewriteUrl("POST", "//v1", anthH)).toBe("/v1/messages");
    expect(fuzzyRewriteUrl("POST", "/v1", h)).toBe("/v1/chat/completions");
    expect(fuzzyRewriteUrl("POST", "/", anthH)).toBe("/v1/messages");
  });

  it("keeps the query string", () => {
    expect(fuzzyRewriteUrl("POST", "//v1/messages?beta=true", h)).toBe("/v1/messages?beta=true");
  });

  it("never touches the dashboard, health, assets, or already-correct routes", () => {
    expect(fuzzyRewriteUrl("POST", "/admin/api/login", h)).toBe("/admin/api/login");
    expect(fuzzyRewriteUrl("GET", "/healthz", h)).toBe("/healthz");
    expect(fuzzyRewriteUrl("GET", "/assets/index-abc.js", h)).toBe("/assets/index-abc.js");
    expect(fuzzyRewriteUrl("POST", "/v1/chat/completions", h)).toBe("/v1/chat/completions");
    expect(fuzzyRewriteUrl("GET", "/", h)).toBe("/"); // the SPA
    expect(fuzzyRewriteUrl("GET", "/logs", h)).toBe("/logs"); // SPA route, GET
  });
});

describe("fuzzy endpoints end-to-end", () => {
  let app: FastifyInstance;
  let upstream: FakeUpstream;
  let port = 0;
  let secret = "";
  let dataDir = "";
  let sqlite: { close: () => void };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-fuzzy-"));
    process.env.NODE_ENV = "test";
    process.env.DATA_DIR = dataDir;
    process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
    process.env.ADMIN_PASSWORD = "fuzzy-test-password";
    process.env.SESSION_SECRET = "fuzzy-test-session-secret";

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

  it("POST //v1 with Anthropic headers lands on /v1/messages", async () => {
    const r = await fetch(`http://127.0.0.1:${port}//v1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "svc", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { type: string; content: Array<{ text: string }> };
    expect(body.type).toBe("message");
    expect(body.content[0].text).toBe("pong");
  });

  it("POST /completions (missing /v1, missing chat/) lands on the chat endpoint", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "svc", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("pong");
  });
});
