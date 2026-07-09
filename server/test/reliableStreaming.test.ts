/**
 * Tests for the Reliable Streaming refactoring:
 *  1. Reliable Streaming ON: buffers full response, simulates paced stream
 *  2. Reliable Streaming OFF: direct passthrough of upstream stream
 *  3. Configurable token rate parameter
 *  4. Buffer-exhaustion stall fix: simulated stream never permanently stalls
 *  5. Non-streaming requests fully buffer upstream response before returning
 */

import { describe, expect, it, beforeEach } from "vitest";
import { Readable, Writable } from "node:stream";
import "../src/core/format"; // register wire formats
import { OpenAICompletionRequest } from "../src/core/format";
import { ModelService, type ServiceDeps } from "../src/execution/modelService";
import { fabricateStream, newAccumulator, tapStream, collectStream, type ResponseData } from "../src/core/ir/stream";
import { serializeStream, parseStream } from "../src/core/format/registry";
import type { Transport, TransportJsonResult, TransportStreamResult, TransportOptions } from "../src/core/upstream/transport";
import type { Catalog } from "../src/catalog/catalog";
import type { GenerationParams } from "../src/core/ir/params";
import type { Family } from "../src/core/format/family";
import { loadConfig } from "../src/config";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OK_FRAMES = [
  'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"delta":{"reasoning":"pondering"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"hello world this is a test"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n',
  "data: [DONE]\n\n",
];

const OK_JSON = {
  id: "c",
  model: "up",
  choices: [{ message: { role: "assistant", content: "hello world this is a test", reasoning: "pondering" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
};

const TRUNCATED_FRAMES = OK_FRAMES.slice(0, 3);

const readableOf = (frames: string[]): Readable =>
  Readable.from(
    (async function* () {
      for (const chunk of frames) yield chunk;
    })(),
  );

/** A readable that emits frames slowly (simulating upstream latency), then completes. */
function slowStream(frames: string[], delayMs: number): Readable {
  return Readable.from(
    (async function* () {
      for (const chunk of frames) {
        await new Promise((r) => setTimeout(r, delayMs));
        yield chunk;
      }
    })(),
  );
}

/** A readable that emits some frames, stalls for a long time, then resumes. */
function stallingStream(frames: string[], stallAfter: number, stallMs: number): Readable {
  return Readable.from(
    (async function* () {
      let i = 0;
      for (const chunk of frames) {
        if (i === stallAfter) {
          // Simulate a temporary upstream stall
          await new Promise((r) => setTimeout(r, stallMs));
        }
        yield chunk;
        i++;
      }
    })(),
  );
}

function fakeCatalog(): Catalog {
  return {
    resolve: (model: string, provider: string) => ({
      ok: true,
      target: {
        family: "openai_completion" as Family,
        upstreamModel: `up-${model}`,
        url: "http://upstream",
        headers: {},
        modelName: model,
        providerName: provider,
        upstream: {},
      },
    }),
    exists: () => true,
  } as unknown as Catalog;
}

function makeTransport(opts: {
  streamFrames?: string[];
  json?: Record<string, unknown> | undefined;
  status?: number;
  stallAfter?: number;
  stallMs?: number;
  slowDelayMs?: number;
}): Transport {
  return {
    async postStream(url: string, headers: Record<string, string>, body: unknown, o: TransportOptions): Promise<TransportStreamResult> {
      const frames = opts.streamFrames ?? OK_FRAMES;
      const status = opts.status ?? 200;
      if (opts.slowDelayMs) {
        return { status, headers: {}, body: slowStream(frames, opts.slowDelayMs) };
      }
      if (opts.stallAfter !== undefined && opts.stallMs) {
        return { status, headers: {}, body: stallingStream(frames, opts.stallAfter, opts.stallMs) };
      }
      return { status, headers: {}, body: readableOf(frames) };
    },
    async postJson(url: string, headers: Record<string, string>, body: unknown, o: TransportOptions): Promise<TransportJsonResult> {
      const status = opts.status ?? 200;
      if (status >= 400) {
        return { status, headers: {}, json: { error: "fail" }, text: "" };
      }
      return { status, headers: {}, json: opts.json ?? OK_JSON, text: "" };
    },
  };
}

function makeDeps(transport: Transport, tokenRate?: number): ServiceDeps {
  return { catalog: fakeCatalog(), transport, simulatedStreamingTokenRate: tokenRate };
}

function baseReq(stream = false): OpenAICompletionRequest {
  return new OpenAICompletionRequest({
    requestedService: "svc",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    params: {},
    stream,
  });
}

class MockRawResponse extends Writable {
  chunks: string[] = [];
  destroyed = false;
  writableEnded = false;

  _write(chunk: string | Buffer, _enc: string, callback: () => void): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  }
  flush(): void {}
  end(cb?: () => void): this { this.writableEnded = true; if (cb) cb(); return this; }
  destroy(): this { this.destroyed = true; return this; }
}

async function relayToRaw(events: AsyncGenerator<any>, model: string): Promise<{ raw: MockRawResponse; output: string }> {
  const raw = new MockRawResponse();
  const outGen = serializeStream("openai_completion", events, { model });
  for await (const chunk of outGen) {
    if (raw.destroyed || raw.writableEnded) break;
    raw.write(chunk);
    raw.flush();
  }
  if (!raw.writableEnded) raw.end();
  return { raw, output: raw.chunks.join("") };
}

const COMPLETE_DATA: ResponseData = {
  id: "r",
  model: "m",
  created: 1,
  content: [
    { type: "reasoning", text: "thinking about the answer" },
    { type: "text", text: "The quick brown fox jumps over the lazy dog." },
  ],
  stopReason: "stop",
  usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
};

// ===========================================================================
// 1. Reliable Streaming ON: buffers full response, simulates paced stream
// ===========================================================================

describe("1. Reliable Streaming ON: full buffer + simulated stream", () => {
  it("1.1 buffers upstream stream and replays as complete paced SSE", async () => {
    // When reliableStreaming is on and client requests stream=true,
    // the proxy should: (a) receive the full upstream stream, (b) buffer it
    // locally, (c) replay it as a paced fabricated stream to the client.
    const transport = makeTransport({ streamFrames: OK_FRAMES });
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p" }], reliableStreaming: true },
      makeDeps(transport, 5000),
    );

    // Client requests stream=true
    const streamInv = await svc.stream(baseReq(true));

    expect(streamInv.result.ok).toBe(true);
    if (streamInv.result.ok) {
      // The events should be a fabricated stream (not the live upstream relay)
      const { output } = await relayToRaw(streamInv.result.value.events, "svc");
      expect(output).toContain("data:");
      // Content is chunked into 24-char deltas, so check for a substring
      expect(output).toContain("hello world this is a te");
      expect(output).toContain("[DONE]");
    }
  });

  it("1.2 preserves client stream=true flag (does NOT override to false)", async () => {
    // Verify the stream=false override is removed: the upstream should receive
    // a stream=true request (postStream is called, not postJson).
    let streamCalled = false;
    let jsonCalled = false;
    const transport: Transport = {
      async postStream() { streamCalled = true; return { status: 200, headers: {}, body: readableOf(OK_FRAMES) }; },
      async postJson() { jsonCalled = true; return { status: 200, headers: {}, json: OK_JSON, text: "" }; },
    };
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p" }], reliableStreaming: true },
      makeDeps(transport, 5000),
    );

    await svc.stream(baseReq(true));

    // Since the client requested stream=true and we no longer override it,
    // the upstream should receive a streaming request (postStream).
    expect(streamCalled).toBe(true);
    expect(jsonCalled).toBe(false);
  });

  it("1.3 detects truncated upstream stream and retries (reliable streaming)", async () => {
    // First call: truncated stream. Second call: OK.
    let callCount = 0;
    const transport: Transport = {
      async postStream() {
        callCount++;
        return callCount === 1
          ? { status: 200, headers: {}, body: readableOf(TRUNCATED_FRAMES) }
          : { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
      async postJson() { return { status: 200, headers: {}, json: OK_JSON, text: "" }; },
    };
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p", retry: { on: [502], maxAttempts: 3, intervalMs: 1, idempotency: "safe_write" } }], reliableStreaming: true },
      makeDeps(transport, 5000),
    );

    const streamInv = await svc.stream(baseReq(true));

    expect(streamInv.result.ok).toBe(true);
    if (streamInv.result.ok) {
      const { output } = await relayToRaw(streamInv.result.value.events, "svc");
      expect(output).toContain("hello world this is a te");
    }
    expect(callCount).toBe(2); // 1 truncated + 1 ok
  });
});

// ===========================================================================
// 2. Reliable Streaming OFF: direct passthrough
// ===========================================================================

describe("2. Reliable Streaming OFF: direct passthrough", () => {
  it("2.1 relays upstream stream directly to client (no buffering)", async () => {
    const transport = makeTransport({ streamFrames: OK_FRAMES });
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p" }] },
      makeDeps(transport),
    );

    const streamInv = await svc.stream(baseReq(true));

    expect(streamInv.result.ok).toBe(true);
    if (streamInv.result.ok) {
      // The events are the live upstream stream (not fabricated)
      const { output } = await relayToRaw(streamInv.result.value.events, "svc");
      expect(output).toContain("data:");
      expect(output).toContain("hello world this is a te");
      expect(output).toContain("[DONE]");
    }
  });

  it("2.2 truncated stream is detected by the accumulator (no retry, no fabrication)", async () => {
    const transport = makeTransport({ streamFrames: TRUNCATED_FRAMES });
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p" }] },
      makeDeps(transport),
    );

    const streamInv = await svc.stream(baseReq(true));

    expect(streamInv.result.ok).toBe(true);
    if (streamInv.result.ok) {
      // Relay the live stream and check the accumulator
      const acc = newAccumulator();
      const outGen = serializeStream("openai_completion", tapStream(streamInv.result.value.events, acc), { model: "svc" });
      const raw = new MockRawResponse();
      for await (const chunk of outGen) {
        if (raw.destroyed || raw.writableEnded) break;
        raw.write(chunk);
        raw.flush();
      }
      if (!raw.writableEnded) raw.end();
      // The accumulator should detect the incomplete stream
      expect(acc.incomplete).toBe(true);
    }
  });
});

// ===========================================================================
// 3. Configurable token rate parameter
// ===========================================================================

describe("3. Configurable token rate", () => {
  it("3.1 default config value is 2000 tokens/second", () => {
    const config = loadConfig({ PORT: "8080", DATA_DIR: "/tmp/test" });
    expect(config.simulatedStreamingTokenRate).toBe(2000);
  });

  it("3.2 config accepts custom token rate from env", () => {
    const config = loadConfig({ PORT: "8080", DATA_DIR: "/tmp/test", SIMULATED_STREAMING_TOKEN_RATE: "500" });
    expect(config.simulatedStreamingTokenRate).toBe(500);
  });

  it("3.3 fabricateStream uses the configured rate for pacing", async () => {
    // With a rate of 10000 tok/s, a ~44-char text (11 tokens) should take ~1.1ms
    // With a rate of 100 tok/s, the same text should take ~110ms
    const data: ResponseData = {
      id: "r", model: "m", created: 1,
      content: [{ type: "text", text: "The quick brown fox jumps over the lazy dog." }], // 44 chars ~11 tokens
      stopReason: "stop",
      usage: { promptTokens: 0, completionTokens: 11, totalTokens: 11 },
    };

    // Fast rate
    const t0 = performance.now();
    for await (const _ of fabricateStream(data, 10000)) { /* drain */ }
    const fastMs = performance.now() - t0;

    // Slow rate
    const t1 = performance.now();
    for await (const _ of fabricateStream(data, 100)) { /* drain */ }
    const slowMs = performance.now() - t1;

    // The slow rate should be significantly slower than the fast rate
    expect(slowMs).toBeGreaterThan(fastMs * 5);
    // The slow rate should be roughly in the 100ms range (11 tokens / 100 tok/s = 110ms)
    expect(slowMs).toBeGreaterThan(50);
  });

  it("3.4 ModelService passes configured rate to fabricateStream", async () => {
    const transport = makeTransport({ json: OK_JSON });
    // Use stream=false so postJson is used (non-streaming path)
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p" }], reliableStreaming: true },
      makeDeps(transport, 100), // 100 tok/s — slow
    );

    const streamInv = await svc.stream(baseReq(false)); // client requests stream=false upstream, but fabricated as stream

    expect(streamInv.result.ok).toBe(true);
    if (streamInv.result.ok) {
      // The fabricated stream should be paced at 100 tok/s
      const t0 = performance.now();
      const { output } = await relayToRaw(streamInv.result.value.events, "svc");
      const elapsed = performance.now() - t0;

      // "hello world this is a test" = 25 chars ~6 tokens, at 100 tok/s = ~60ms
      expect(output).toContain("hello world this is a te");
      expect(elapsed).toBeGreaterThan(30); // should be paced, not instant
    }
  });
});

// ===========================================================================
// 4. Buffer-exhaustion stall fix
// ===========================================================================

describe("4. Buffer-exhaustion stall fix", () => {
  it("4.1 fabricateStream never permanently stalls — all data is in memory", async () => {
    // The fabricated stream reads from a complete ResponseData (all in memory).
    // Even if setTimeout has jitter, the self-correcting pacer skips the delay
    // when it's already overdue. The stream must always complete.
    const data: ResponseData = {
      id: "r", model: "m", created: 1,
      content: [{ type: "text", text: "A".repeat(1000) }], // 1000 chars ~250 tokens
      stopReason: "stop",
      usage: { promptTokens: 0, completionTokens: 250, totalTokens: 250 },
    };

    const events: any[] = [];
    const t0 = performance.now();
    for await (const ev of fabricateStream(data, 2000)) {
      events.push(ev);
    }
    const elapsed = performance.now() - t0;

    // Should complete in roughly 125ms (250 tokens / 2000 tok/s)
    // but MUST complete — never stall forever.
    expect(elapsed).toBeLessThan(5000); // generous upper bound
    expect(events.length).toBeGreaterThan(0);
    const finish = events[events.length - 1];
    expect(finish.type).toBe("finish");
  });

  it("4.2 simulated stream completes even after upstream temporary stall", async () => {
    // Simulate: upstream stalls mid-stream (200ms pause), then resumes.
    // With reliable streaming, the proxy buffers the FULL upstream response
    // (including the stalling part) before fabricating the client stream.
    // The client stream should never see the stall — it's fully buffered.
    const transport = makeTransport({
      streamFrames: OK_FRAMES,
      stallAfter: 2, // stall after frame 2
      stallMs: 200,  // 200ms stall
    });
    const svc = new ModelService(
      { timeoutMs: 30000, steps: [{ model: "m", provider: "p" }], reliableStreaming: true },
      makeDeps(transport, 5000),
    );

    const streamInv = await svc.stream(baseReq(true));

    expect(streamInv.result.ok).toBe(true);
    if (streamInv.result.ok) {
      // The fabricated stream should complete without stalling
      const t0 = performance.now();
      const { output } = await relayToRaw(streamInv.result.value.events, "svc");
      const elapsed = performance.now() - t0;

      expect(output).toContain("hello world this is a te");
      expect(output).toContain("[DONE]");
      // The client-side stream should be fast (data is already buffered)
      // The 200ms upstream stall is absorbed during buffering, not replayed.
      expect(elapsed).toBeLessThan(2000);
    }
  });

  it("4.3 pacer self-corrects: does not accumulate delay across chunks", async () => {
    // If the pacer falls behind (e.g. due to event loop congestion), it should
    // catch up by skipping delays, not accumulate them into a permanent stall.
    const data: ResponseData = {
      id: "r", model: "m", created: 1,
      content: [{ type: "text", text: "B".repeat(480) }], // 480 chars ~120 tokens
      stopReason: "stop",
      usage: { promptTokens: 0, completionTokens: 120, totalTokens: 120 },
    };

    // At 1000 tok/s, 120 tokens should take ~120ms.
    // Even with jitter, the self-correcting pacer should not take > 5x that.
    const t0 = performance.now();
    let eventCount = 0;
    for await (const _ of fabricateStream(data, 1000)) {
      eventCount++;
    }
    const elapsed = performance.now() - t0;

    expect(eventCount).toBeGreaterThan(2); // start + deltas + finish
    // Must complete in reasonable time — no permanent stall
    expect(elapsed).toBeLessThan(2000);
  });
});

// ===========================================================================
// 5. Non-streaming requests fully buffer upstream response
// ===========================================================================

describe("5. Non-streaming requests fully buffer upstream response", () => {
  it("5.1 non-streaming request returns complete buffered response (JSON path)", async () => {
    const transport = makeTransport({ json: OK_JSON });
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p" }] },
      makeDeps(transport),
    );

    // Client requests stream=false
    const inv = await svc.invoke(baseReq(false));

    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      // The response should be the complete buffered response
      const text = inv.result.value.response.text();
      expect(text).toBe("hello world this is a test");
      expect(inv.result.value.response.usage.totalTokens).toBe(8);
    }
  });

  it("5.2 non-streaming request with stream=true upstream buffers via collectStream", async () => {
    // When the request has stream=true (even for a non-streaming client path),
    // sendBuffered streams the upstream and collects it via collectStream.
    // This is the path used by Micro Agents and reliable streaming.
    const transport = makeTransport({ streamFrames: OK_FRAMES });
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p" }] },
      makeDeps(transport),
    );

    // Use stream=true request but invoke (not stream) — this is what
    // MicroAgent.callService does (it calls service.invoke with stream=true).
    const inv = await svc.invoke(baseReq(true));

    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      // The stream was fully collected into a Response
      const text = inv.result.value.response.text();
      expect(text).toBe("hello world this is a test");
      expect(inv.result.value.response.usage.totalTokens).toBe(8);
    }
  });

  it("5.3 non-streaming request with reliable streaming buffers then renders", async () => {
    // Even with reliableStreaming on, a non-streaming client request
    // should return a complete buffered JSON response (not a fabricated stream).
    const transport = makeTransport({ json: OK_JSON });
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p" }], reliableStreaming: true },
      makeDeps(transport, 2000),
    );

    // Client requests stream=false → ProxyController calls invoke(), not stream()
    const inv = await svc.invoke(baseReq(false));

    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      const text = inv.result.value.response.text();
      expect(text).toBe("hello world this is a test");
    }
  });
});
