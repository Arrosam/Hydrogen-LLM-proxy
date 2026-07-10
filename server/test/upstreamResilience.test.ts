/**
 * Upstream failure modes, end to end, over real sockets, with large inputs and
 * large outputs.
 *
 * The contract under test: when the proxy CAN retry, the downstream user must
 * receive the complete answer, byte for byte. When the proxy CANNOT retry
 * (headers already committed on a passthrough stream), the user must at least
 * be able to tell that the answer is incomplete — a truncated response must
 * never be dressed up as a finished one.
 *
 * Covers Model Services (passthrough and Reliable Streaming), a multi-stage
 * Micro Agent, and a Micro Agent with an OCR pre-pass.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";

// ---------------------------------------------------------------------------
// sizes — "large input, large output"
// ---------------------------------------------------------------------------

const REQUEST_CHARS = 1_000_000;
const RESPONSE_CHARS = 100_000;

/** ASCII + CJK + emoji: chunk boundaries land inside multi-byte sequences. */
function mixedText(chars: number): string {
  const alphabet = "abcdefghij你好世界测试代码🙂🚀漢字カタカナ";
  let s = "";
  while (s.length < chars) s += alphabet;
  return s.slice(0, chars);
}

const ANSWER = mixedText(RESPONSE_CHARS);

/** 1x1 transparent PNG. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const STEP = { model: "m", provider: "fake" } as const;
/** Retries everything the proxy can classify. `"error"` matches any failure. */
const RESILIENT = { maxAttempts: 4, on: [429, 500, 502, 503, 499, "timeout", "error"], intervalMs: 0 };

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  upstream: FakeUpstream;
  port: number;
  secret: string;
  dataDir: string;
  sqlite: { close: () => void; prepare: (s: string) => { get: () => unknown } };
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

async function boot(definition: unknown, script: UpstreamBehavior[], timeoutMs = 60_000): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-resil-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "resilience-test-password";
  process.env.SESSION_SECRET = "resilience-test-session-secret";
  process.env.SIMULATED_STREAMING_TOKEN_RATE = "2000000"; // pacing is not what we test here
  void timeoutMs;

  const upstream = await startFakeUpstream({ text: ANSWER, chunkChars: 200, script, seed: 3 });

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

interface ClientResult {
  status: number;
  text: string;
  sawDone: boolean;
  /** The HTTP response ended without a clean end-of-message. */
  aborted: boolean;
  errorBody: string;
}

/** Drive the proxy the way a streaming SDK does, and reassemble the answer. */
function stream(port: number, secret: string, withImage = false): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const content: unknown[] = [{ type: "text", text: "A".repeat(REQUEST_CHARS) }];
    if (withImage) content.push({ type: "image_url", image_url: { url: PNG } });
    const payload = Buffer.from(JSON.stringify({ model: "svc", stream: true, messages: [{ role: "user", content }] }));

    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) } },
      (res) => {
        let text = "", buffer = "", raw = "", sawDone = false;
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          raw += c;
          buffer += c;
          let i: number;
          while ((i = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            if (!frame.startsWith("data:")) continue;
            const data = frame.slice(5).trim();
            if (data === "[DONE]") { sawDone = true; continue; }
            try {
              const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
              if (typeof delta === "string") text += delta;
            } catch { /* not a content frame */ }
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text, sawDone, aborted: false, errorBody: raw.slice(0, 200) }));
        res.on("aborted", () => resolve({ status: res.statusCode ?? 0, text, sawDone, aborted: true, errorBody: raw.slice(0, 200) }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0, text, sawDone, aborted: true, errorBody: raw.slice(0, 200) }));
      },
    );
    // The proxy aborts the connection on a truncated answer, which surfaces here
    // as a socket hang up. That is the signal under test, not a failure.
    req.on("error", () => resolve({ status: 0, text: "", sawDone: false, aborted: true, errorBody: "" }));
    req.end(payload);
    void reject;
  });
}

/** The relay writes its log row after the response settles, so give it a beat. */
async function loggedStatus(h: Harness): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const row = h.sqlite.prepare("SELECT http_status FROM request_logs ORDER BY id DESC LIMIT 1").get() as { http_status: number } | undefined;
    if (row) return row.http_status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no request_logs row was ever written");
}

// ---------------------------------------------------------------------------
// service definitions
// ---------------------------------------------------------------------------

const msPassthrough = { timeoutMs: 20_000, steps: [{ ...STEP, retry: RESILIENT }] };
const msReliable = { timeoutMs: 20_000, reliableStreaming: true, steps: [{ ...STEP, retry: RESILIENT }] };
const agentMultiTurn = {
  kind: "micro_agent", timeoutMs: 60_000,
  stages: [
    { name: "draft", steps: [{ ...STEP, retry: RESILIENT }], input: [] },
    { name: "refine", steps: [{ ...STEP, retry: RESILIENT }], input: [{ kind: "stage_output", stage: "draft", role: "assistant" }] },
  ],
};
const agentWithOcr = {
  kind: "micro_agent", timeoutMs: 60_000,
  ocr: { steps: [{ ...STEP, retry: RESILIENT }] },
  stages: [{ name: "answer", steps: [{ ...STEP, retry: RESILIENT }], input: [] }],
};

/** Failures the upstream reports before it sends any response body. */
const HEADER_FAILURES: Array<[string, UpstreamBehavior]> = [
  ["429 rate limit", { kind: "status", status: 429 }],
  ["503 unavailable", { kind: "status", status: 503 }],
  ["500 server error", { kind: "status", status: 500 }],
  ["timeout / hang", { kind: "hang", ms: 3_000 }],
];

/**
 * Failures that arrive with a 200 and a body. A buffering service (Reliable
 * Streaming, any Micro Agent stage) sees these before it commits anything to
 * the client, so it can retry. A passthrough stream cannot: its 200 is already
 * on the wire.
 */
const BODY_FAILURES: Array<[string, UpstreamBehavior]> = [
  ["clean EOF mid-answer", { kind: "truncate", afterChars: 20_000 }],
  ["socket reset mid-answer", { kind: "reset", afterChars: 20_000 }],
  ["unparsable body", { kind: "garbage" }],
];

const ALL_FAILURES = [...HEADER_FAILURES, ...BODY_FAILURES];

// ---------------------------------------------------------------------------
// Reliable Streaming: nothing is committed until the answer is whole
// ---------------------------------------------------------------------------

describe("Reliable Streaming — the user always gets the whole answer", () => {
  for (const [name, failure] of ALL_FAILURES) {
    it(`recovers from ${name} and delivers the complete answer`, async () => {
      const h = await boot({ ...msReliable, timeoutMs: 2_000 }, [failure]);
      const got = await stream(h.port, h.secret);

      expect(got.status).toBe(200);
      expect(got.sawDone).toBe(true);
      expect(got.text).toBe(ANSWER);
      expect(h.upstream.requests).toBe(2); // one failure, one success
      expect(await loggedStatus(h)).toBe(200);
    }, 60_000);
  }

  it("exhausts its retries and returns a clean error rather than a partial answer", async () => {
    const failing: UpstreamBehavior[] = Array.from({ length: 4 }, () => ({ kind: "truncate", afterChars: 20_000 }));
    const h = await boot({ ...msReliable, timeoutMs: 5_000 }, failing);
    const got = await stream(h.port, h.secret);

    expect(got.status).toBeGreaterThanOrEqual(400);
    expect(got.text).toBe(""); // never a partial answer
    expect(h.upstream.requests).toBe(4);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Micro Agent: multi-turn, and with an OCR pre-pass
// ---------------------------------------------------------------------------

describe("Micro Agent (multi-turn) — the user always gets the whole answer", () => {
  for (const [name, failure] of ALL_FAILURES) {
    it(`recovers from ${name} in the first stage`, async () => {
      const h = await boot({ ...agentMultiTurn, timeoutMs: 2_000 }, [failure]);
      const got = await stream(h.port, h.secret);

      expect(got.status).toBe(200);
      expect(got.sawDone).toBe(true);
      expect(got.text).toBe(ANSWER);
      expect(h.upstream.requests).toBe(3); // stage1 fail, stage1 retry, stage2
      expect(await loggedStatus(h)).toBe(200);
    }, 60_000);
  }

  it("recovers from a failure in the SECOND stage", async () => {
    // attempt 1 = stage 1 (ok), attempt 2 = stage 2 (fails), attempt 3 = retry.
    const h = await boot({ ...agentMultiTurn, timeoutMs: 5_000 }, [{ kind: "ok" }, { kind: "status", status: 503 }]);
    const got = await stream(h.port, h.secret);

    expect(got.status).toBe(200);
    expect(got.text).toBe(ANSWER);
    expect(h.upstream.requests).toBe(3);
  }, 60_000);
});

describe("Micro Agent with OCR — the user always gets the whole answer", () => {
  it("passes an image through the OCR pre-pass and answers completely", async () => {
    const h = await boot(agentWithOcr, []);
    const got = await stream(h.port, h.secret, true);

    expect(got.status).toBe(200);
    expect(got.text).toBe(ANSWER);
    expect(h.upstream.ocrRequests).toBe(1);
    expect(h.upstream.requests).toBe(2); // ocr + answer stage
  }, 60_000);

  for (const [name, failure] of ALL_FAILURES) {
    it(`recovers from ${name} during the OCR pre-pass`, async () => {
      const h = await boot({ ...agentWithOcr, timeoutMs: 2_000 }, [failure]);
      const got = await stream(h.port, h.secret, true);

      expect(got.status).toBe(200);
      expect(got.sawDone).toBe(true);
      expect(got.text).toBe(ANSWER);
      expect(h.upstream.ocrRequests).toBe(2); // the OCR call was retried
      expect(h.upstream.requests).toBe(3); // ocr fail, ocr retry, answer stage
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// Passthrough: retryable before the response commits; visibly broken after
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The shipped defaults, with no retry block configured at all. Reliable
// Streaming exists to retry an upstream that fails to deliver a whole answer,
// so those failures have to be default triggers or the mode does nothing.
// ---------------------------------------------------------------------------

describe("Reliable Streaming with NO retry config — the defaults must carry it", () => {
  const bare = { timeoutMs: 20_000, reliableStreaming: true, steps: [STEP] };

  const recovered: Array<[string, UpstreamBehavior]> = [
    ["429 rate limit", { kind: "status", status: 429 }],
    ["503 unavailable", { kind: "status", status: 503 }],
    ["clean EOF mid-answer", { kind: "truncate", afterChars: 20_000 }],
    ["socket reset mid-answer", { kind: "reset", afterChars: 20_000 }],
    ["unparsable body", { kind: "garbage" }],
    ["connection refused before headers", { kind: "hangup" }],
  ];

  for (const [name, failure] of recovered) {
    it(`recovers from ${name} using only the default triggers`, async () => {
      const h = await boot(bare, [failure]);
      const got = await stream(h.port, h.secret);

      expect(got.status).toBe(200);
      expect(got.text).toBe(ANSWER);
      expect(h.upstream.requests).toBe(2);
    }, 60_000);
  }

  it("does not retry a 401 on the defaults — an auth failure must not burn quota", async () => {
    const h = await boot(bare, [{ kind: "status", status: 401 }, { kind: "status", status: 401 }]);
    const got = await stream(h.port, h.secret);

    expect(h.upstream.requests).toBe(1);
    expect(got.status).toBe(401);
  }, 60_000);

  it("does not retry a 500 on the defaults", async () => {
    const h = await boot(bare, [{ kind: "status", status: 500 }]);
    const got = await stream(h.port, h.secret);

    expect(h.upstream.requests).toBe(1);
    expect(got.status).toBe(500);
  }, 60_000);
});

describe("Model Service (passthrough)", () => {
  for (const [name, failure] of HEADER_FAILURES) {
    it(`recovers from ${name} before committing, and delivers the whole answer`, async () => {
      const h = await boot({ ...msPassthrough, timeoutMs: 2_000 }, [failure]);
      const got = await stream(h.port, h.secret);

      expect(got.status).toBe(200);
      expect(got.sawDone).toBe(true);
      expect(got.text).toBe(ANSWER);
      expect(h.upstream.requests).toBe(2);
    }, 60_000);
  }

  for (const [name, failure] of BODY_FAILURES) {
    it(`cannot retry ${name} after committing — but must not look complete`, async () => {
      const h = await boot({ ...msPassthrough, timeoutMs: 5_000 }, [failure]);
      const got = await stream(h.port, h.secret);

      // The answer IS short — unavoidable once 200 is on the wire. What must
      // never happen is a truncated answer that terminates like a finished one.
      expect(got.text.length).toBeLessThan(ANSWER.length);
      expect(got.sawDone).toBe(false);
      expect(got.aborted).toBe(true); // the client can see the stream broke
      expect(await loggedStatus(h)).not.toBe(200);
    }, 60_000);
  }
});
