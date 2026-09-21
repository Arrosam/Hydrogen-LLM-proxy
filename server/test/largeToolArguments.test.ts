import { afterEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { parseSSE, collectStream } from "../src/core/ir/stream";
import { parseResponse, parseStream } from "../src/core/format/registry";
import { runHostedTools } from "../src/execution/hostedToolLoop";
import { HttpToolSchema } from "../src/execution/toolHttp";
import { HostedToolOptionsSchema } from "../src/execution/definition";
import { guardToolArguments, MAX_SSE_FRAME_BYTES } from "../src/core/ir/toolArguments";
import type { StreamEvent } from "../src/core/ir/stream";
import { families, fileArguments, observeCall, parameters, startToolHarness, toolFrames, toolRequest } from "./fixtures/toolCallHarness";

let harness: Awaited<ReturnType<typeof startToolHarness>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

describe("large tool arguments over real sockets", () => {
  for (const upstream of families) for (const downstream of families) for (const stream of [true, false]) {
    it(`${upstream} -> ${downstream}, stream=${stream}: preserves a 256 KiB call`, async () => {
      const args = fileArguments(256 * 1024);
      harness = await startToolHarness({ family: upstream, args, deltaChars: 997, packetBytes: 811 });
      const r = await observeCall(harness.proxyUrl, downstream, stream);
      expect(r.error).toBeUndefined(); expect(r.terminal).toBe(true);
      expect(stream ? r.args : parseResponse(downstream, r.json).toolCalls()[0]?.args).toBe(args);
      expect(harness.dispatches).toHaveLength(0); // only the external client can execute this call
    });
  }

  it.each(families)("%s: argument deltas progress before completion", async family => {
    harness = await startToolHarness({ family, args: fileArguments(32768), deltaChars: 1024, delayMs: 2 });
    const r = await observeCall(harness.proxyUrl, "anthropic");
    expect(r.deltas).toBe(32);
    expect(r.firstDeltaMs!).toBeLessThan(r.lastDeltaMs! - 20);
    expect(r.terminal).toBe(true);
  });

  it("delivers a 4 MiB many-delta Responses call and its repeated completion snapshots exactly once", async () => {
    const args = fileArguments(4 * 1024 * 1024);
    harness = await startToolHarness({ family: "openai_responses", args, deltaChars: 1024, packetBytes: 1024 });
    const r = await observeCall(harness.proxyUrl, "anthropic", true, AbortSignal.timeout(8000));
    expect(r.args).toBe(args); expect(r.terminal).toBe(true); expect(r.deltas).toBe(4096);
    expect(r.totalMs).toBeLessThan(6000); // baseline repeats the quadratic 4 MiB scan three times
  }, 10000);

  it("fails an oversized frame with a structured error and closes the upstream", async () => {
    harness = await startToolHarness({ family: "openai_completion", args: fileArguments(MAX_SSE_FRAME_BYTES + 1), deltaChars: MAX_SSE_FRAME_BYTES + 1 });
    const r = await observeCall(harness.proxyUrl, "anthropic");
    expect(r.terminal).toBe(false);
    expect(r.error).toMatchObject({ message: expect.stringContaining("SSE frame exceeds") });
    await delay(30); expect(harness.upstreamTimes.closed).toBeDefined();
    expect(harness.logs.at(-1)?.httpStatus).toBe(502);
  }, 15000);

  it("cancels while the downstream is applying backpressure", async () => {
    harness = await startToolHarness({ family: "openai_completion", args: fileArguments(4 * 1024 * 1024), deltaChars: 65536, delayMs: 1 });
    const r = await observeCall(harness.proxyUrl, "openai_responses", true, AbortSignal.timeout(150), 20);
    expect(r.terminal).toBe(false); expect(r.error).toBeDefined();
    await delay(50); expect(harness.upstreamTimes.closed).toBeDefined();
    expect(harness.logs.at(-1)?.httpStatus).toBe(499);
  });

  it.each(families)("%s: terminal events complete even if upstream keeps the socket open", async family => {
    harness = await startToolHarness({ family, args: fileArguments(1024), holdOpen: true });
    const r = await observeCall(harness.proxyUrl, "openai_responses", true, AbortSignal.timeout(1500));
    expect(r.error).toBeUndefined(); expect(r.terminal).toBe(true);
    expect(r.totalMs).toBeLessThan(1000);
    await delay(30); expect(harness.upstreamTimes.closed).toBeDefined();
  });

  it.each(families)("%s: truncated arguments never become a complete call", async family => {
    harness = await startToolHarness({ family, args: fileArguments(4096).slice(0, -4), truncate: true });
    const r = await observeCall(harness.proxyUrl, "anthropic");
    expect(r.terminal).toBe(false); expect(r.error).toBeDefined();
    expect(harness.dispatches).toHaveLength(0);
  });

  it.each(families)("%s: malformed arguments fail explicitly even with a terminal event", async family => {
    harness = await startToolHarness({ family, args: '{"content":"PRIVATE_CONTENT', deltaChars: 3 });
    const r = await observeCall(harness.proxyUrl, "openai_responses");
    expect(r.terminal).toBe(false);
    expect(r.error).toMatchObject({ message: expect.stringContaining("tool arguments") });
    expect(JSON.stringify(r.error)).not.toContain("PRIVATE_CONTENT");
  });

  it("idle timeout finishes a stalled argument stream; downstream disconnect aborts a comment stream", async () => {
    harness = await startToolHarness({ family: "openai_completion", args: fileArguments(8192), stall: "silent" }, { timeoutMs: 1000 });
    const r = await observeCall(harness.proxyUrl, "anthropic", true, AbortSignal.timeout(4000));
    expect(r.terminal).toBe(false); expect(r.error).toBeDefined(); expect(r.totalMs).toBeLessThan(3500);
    await harness.close();
    harness = await startToolHarness({ family: "openai_responses", args: fileArguments(8192), stall: "comments" });
    const cancelled = await observeCall(harness.proxyUrl, "anthropic", true, AbortSignal.timeout(150));
    expect(cancelled.terminal).toBe(false); expect(cancelled.error).toBeDefined();
    await delay(50); expect(harness.upstreamTimes.closed).toBeDefined();
    expect(harness.logs.at(-1)?.httpStatus).toBe(499);
  });

  it("hosted execution starts only after complete arguments, and the 1 MiB adapter limit fails explicitly", async () => {
    for (const bytes of [1024, 256 * 1024, 1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1]) {
      harness = await startToolHarness({ family: "openai_completion", args: fileArguments(bytes), deltaChars: 1024 });
      const tool = HttpToolSchema.parse({ name: "write_file", parameters, url: harness.upstreamUrl + "/tool", bodyTemplate: { path: "{{arguments.path}}", content: "{{arguments.content}}" } });
      const run = await runHostedTools(harness.executor, toolRequest("openai_completion", true, true), [tool], harness.transport,
        { sessionId: "large-args-test", config: HostedToolOptionsSchema.parse({ streamMode: "all" }), emit: async () => {}, logMaxChars: () => 0 });
      expect(run.value.response.text()).toBe("written");
      if (bytes <= 1024 * 1024) {
        expect(harness.dispatches).toHaveLength(1);
        expect(harness.dispatches[0].at).toBeGreaterThanOrEqual(harness.upstreamTimes.terminal!);
      } else {
        expect(harness.dispatches).toHaveLength(0);
        expect(run.traces.find(e => e.type === "hydrogen.tool.completed")).toMatchObject({ isError: true, output: expect.stringContaining("invalid_arguments") });
      }
      await harness.close(); harness = undefined;
    }
  }, 15000);

  it.each([true, false])("malformed arguments never enter a permissive hosted adapter (stream=%s)", async stream => {
    harness = await startToolHarness({ family: "openai_completion", args: '{"content":"PRIVATE_CONTENT' });
    const tool = HttpToolSchema.parse({ name: "write_file", parameters: { type: "object" }, url: harness.upstreamUrl + "/tool", bodyTemplate: {} });
    await expect(runHostedTools(harness.executor, toolRequest("openai_completion", stream, true), [tool], harness.transport,
      { sessionId: "invalid", config: HostedToolOptionsSchema.parse({ streamMode: stream ? "all" : "final" }), emit: async () => {} })).rejects.toThrow("tool arguments");
    expect(harness.dispatches).toHaveLength(0);
  });
});

describe("SSE parsing work and boundaries", () => {
  it("counts UTF-8 frame bytes at the limit, resets per frame and supports multiline data/EOF", async () => {
    const frame = "event: test\r\ndata: 雪\r\ndata: 🙂\r\n\r\n";
    const bytes = Buffer.byteLength(frame);
    const read = async (wire: string, limit: number) => {
      const result = []; for await (const f of parseSSE(Readable.from([Buffer.from(wire)]), limit)) result.push(f); return result;
    };
    expect(await read(frame.repeat(2), bytes)).toEqual([{ event: "test", data: "雪\n🙂" }, { event: "test", data: "雪\n🙂" }]);
    await expect(read(frame, bytes - 1)).rejects.toThrow("SSE frame exceeds");
    expect(await read(": comment\n\ndata: {}", bytes)).toEqual([{ event: undefined, data: "" }, { event: undefined, data: "{}" }]);
    const source = Readable.from([Buffer.from("data: " + "x".repeat(256))]);
    await expect((async () => { for await (const _ of parseSSE(source, 128)) { /* no complete frame */ } })()).rejects.toThrow("SSE frame exceeds");
    expect(source.destroyed).toBe(true);
  });

  it("caps cumulative tool arguments across small frames and multiple calls", async () => {
    async function* events(): AsyncGenerator<StreamEvent> {
      for (let index = 0; index < 2; index++) {
        yield { type: "tool_start", index, id: String(index), name: "f" };
        yield { type: "tool_args_delta", index, delta: '{"x":' };
        yield { type: "tool_args_delta", index, delta: '"雪"}' };
        yield { type: "tool_stop", index };
      }
      yield { type: "finish", stopReason: "tool_use" };
    }
    const bytes = 2 * Buffer.byteLength('{"x":"雪"}');
    const drain = async (limit: number) => { for await (const _ of guardToolArguments(events(), limit)) { /* consume */ } };
    await expect(drain(bytes)).resolves.toBeUndefined();
    await expect(drain(bytes - 1)).rejects.toThrow("tool arguments exceed");
  });

  it("counts split surrogate pairs by their joined UTF-8 size", async () => {
    const args = JSON.stringify({ content: "🙂🚀🙂🚀" });
    async function* events(): AsyncGenerator<StreamEvent> {
      yield { type: "tool_start", index: 0, id: "a", name: "f" };
      for (let i = 0; i < args.length; i++) yield { type: "tool_args_delta", index: 0, delta: args[i] };
      yield { type: "tool_stop", index: 0 };
      yield { type: "finish", stopReason: "tool_use" };
    }
    const result = await collectStream(guardToolArguments(events(), Buffer.byteLength(args)));
    expect(result.data.content[0]).toMatchObject({ input: JSON.parse(args) });
  });
  it("parses a fragmented 4 MiB frame within a bounded CPU budget", async () => {
    const frame = Buffer.from(`data: ${JSON.stringify({ arguments: fileArguments(4 * 1024 * 1024) })}\n\n`);
    async function* chunks() { for (let i = 0; i < frame.length; i += 1024) yield frame.subarray(i, i + 1024); }
    const start = performance.now(); let count = 0;
    for await (const f of parseSSE(chunks())) { expect(JSON.parse(f.data).arguments.length).toBe(4 * 1024 * 1024); count++; }
    // Old parser takes ~3.6s here; linear parsing takes tens of ms. Wide margin for CI.
    expect(performance.now() - start).toBeLessThan(1500); expect(count).toBe(1);
  }, 15000);

  it.each(families)("%s preserves UTF-8, JSON escapes and CRLF split at every byte", async family => {
    const args = JSON.stringify({ path: "雪.txt", content: '🙂漢字\n"quoted"\\path\t🚀' });
    const wire = Buffer.from([...toolFrames({ family, args, deltaChars: 1 })].join("").replaceAll("\n", "\r\n"));
    const chunks = Readable.from((function* () { for (let i = 0; i < wire.length; i++) yield wire.subarray(i, i + 1); })());
    const r = await collectStream(parseStream(family, chunks));
    expect(r.incomplete).toBe(false);
    expect(r.data.content[0]).toMatchObject({ type: "tool_use", input: JSON.parse(args) });
  });
});
