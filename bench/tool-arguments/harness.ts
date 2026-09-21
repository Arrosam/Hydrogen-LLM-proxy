/** Run from the repository root: node --expose-gc --import tsx bench/tool-arguments/harness.ts [parser|matrix|sweep|hosted] */
import { createHash } from "node:crypto";
import { parseSSE } from "../../server/src/core/ir/stream";
import { parseResponse } from "../../server/src/core/format/registry";
import { runHostedTools } from "../../server/src/execution/hostedToolLoop";
import { HttpToolSchema } from "../../server/src/execution/toolHttp";
import { HostedToolOptionsSchema } from "../../server/src/execution/definition";
import { families, fileArguments, observeCall, parameters, startToolHarness, toolRequest, type ToolScenario } from "../../server/test/fixtures/toolCallHarness";

const mode = process.argv[2] ?? "sweep";
const mib = (n: number) => +(n / 1024 ** 2).toFixed(2);
const rounded = (n: number | undefined) => n == null ? null : +n.toFixed(2);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
console.log(JSON.stringify({ mode, node: process.version, platform: process.platform, arch: process.arch }));
if (mode === "parser") {
  for (const size of [1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
    const frame = Buffer.from(`data: ${JSON.stringify({ arguments: fileArguments(size) })}\n\n`);
    global.gc?.();
    const before = process.memoryUsage(); let heap = before.heapUsed, rss = before.rss;
    let count = 0;
    async function* chunks() {
      for (let i = 0; i < frame.length; i += 1024) {
        const m = process.memoryUsage(); heap = Math.max(heap, m.heapUsed); rss = Math.max(rss, m.rss);
        yield frame.subarray(i, i + 1024);
      }
    }
    const start = performance.now();
    for await (const f of parseSSE(chunks())) { JSON.parse(f.data); count++; }
    console.log(JSON.stringify({ size, packetBytes: 1024, ms: rounded(performance.now() - start), heapGrowthMiB: mib(heap - before.heapUsed), rssGrowthMiB: mib(rss - before.rss), frames: count }));
  }
} else if (mode === "hosted") {
  for (const family of families) for (const stream of [true, false]) for (const size of [1024, 256 * 1024, 1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1, 4 * 1024 * 1024]) {
    const h = await startToolHarness({ family, args: fileArguments(size), deltaChars: 1024 });
    global.gc?.(); const before = process.memoryUsage(); let heap = before.heapUsed, rss = before.rss;
    const sample = setInterval(() => { const m = process.memoryUsage(); heap = Math.max(heap, m.heapUsed); rss = Math.max(rss, m.rss); }, 2);
    const started = performance.now(); let toolStarted: number | undefined;
    try {
      const tool = HttpToolSchema.parse({ name: "write_file", parameters, url: h.upstreamUrl + "/tool", bodyTemplate: { path: "{{arguments.path}}", content: "{{arguments.content}}" } });
      const result = await runHostedTools(h.executor, toolRequest(family, stream, true), [tool], h.transport, {
        sessionId: "bench", logMaxChars: () => 0, config: HostedToolOptionsSchema.parse({ streamMode: stream ? "all" : "final" }),
        emit: async event => { if (event.type === "hydrogen.tool.started") toolStarted = performance.now(); },
      });
      const completion = result.traces.find(e => e.type === "hydrogen.tool.completed");
      const m = process.memoryUsage(); heap = Math.max(heap, m.heapUsed); rss = Math.max(rss, m.rss);
      console.log(JSON.stringify({ family, stream, size, totalMs: rounded(performance.now() - started),
        upstreamFirstMs: rounded(h.upstreamTimes.firstDelta == null ? undefined : h.upstreamTimes.firstDelta - started),
        upstreamLastMs: rounded(h.upstreamTimes.lastDelta == null ? undefined : h.upstreamTimes.lastDelta - started),
        irFirstMs: rounded(h.irTimes.firstDelta == null ? undefined : h.irTimes.firstDelta - started), irLastMs: rounded(h.irTimes.lastDelta == null ? undefined : h.irTimes.lastDelta - started), irDeltas: h.irTimes.deltas,
        toolStartedMs: rounded(toolStarted == null ? undefined : toolStarted - started), adapterEnteredMs: rounded(h.dispatches[0] == null ? undefined : h.dispatches[0].at - started),
        dispatches: h.dispatches.length, toolError: completion?.isError ?? null, heapGrowthMiB: mib(heap - before.heapUsed), rssGrowthMiB: mib(rss - before.rss) }));
    } finally { clearInterval(sample); await h.close(); }
  }
} else {
  const scenarios: Array<{ scenario: ToolScenario; downstream: ToolScenario["family"]; stream: boolean; reliable?: boolean }> = [];
  if (mode === "matrix") {
    for (const family of families) for (const downstream of families) for (const stream of [true, false]) {
      scenarios.push({ scenario: { family, args: fileArguments(256 * 1024), deltaChars: 1024 }, downstream, stream });
    }
  } else {
    for (const size of [1024, 256 * 1024, 1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1, 4 * 1024 * 1024]) {
      for (const family of families) scenarios.push({ scenario: { family, args: fileArguments(size), deltaChars: 1024, packetBytes: 1024 }, downstream: "anthropic", stream: true });
    }
    scenarios.push({ scenario: { family: "openai_responses", args: fileArguments(4 * 1024 * 1024), snapshotOnly: true, packetBytes: 1024 }, downstream: "anthropic", stream: true });
    scenarios.push({ scenario: { family: "openai_completion", args: fileArguments(4 * 1024 * 1024), deltaChars: 4 * 1024 * 1024, packetBytes: 1024 }, downstream: "anthropic", stream: true });
    scenarios.push({ scenario: { family: "openai_completion", args: fileArguments(256 * 1024), deltaChars: 4096, delayMs: 2 }, downstream: "anthropic", stream: true });
    scenarios.push({ scenario: { family: "openai_completion", args: fileArguments(256 * 1024), deltaChars: 4096, delayMs: 2 }, downstream: "anthropic", stream: true, reliable: true });
  }
  for (const { scenario, downstream, stream, reliable } of scenarios) {
    for (const route of ["direct", "proxy"] as const) {
      const h = await startToolHarness(scenario, { reliable });
      global.gc?.(); const before = process.memoryUsage(); let heap = before.heapUsed, rss = before.rss;
      const sample = setInterval(() => { const m = process.memoryUsage(); heap = Math.max(heap, m.heapUsed); rss = Math.max(rss, m.rss); }, 2);
      try {
        const family = route === "direct" ? scenario.family : downstream;
        const r = await observeCall(route === "direct" ? h.upstreamUrl : h.proxyUrl, family, stream, AbortSignal.timeout(60000));
        const args = stream ? r.args : parseResponse(family, r.json).toolCalls()[0]?.args;
        const m = process.memoryUsage(); heap = Math.max(heap, m.heapUsed); rss = Math.max(rss, m.rss);
        console.log(JSON.stringify({ route, upstream: scenario.family, downstream: family, stream, reliable: !!reliable, size: Buffer.byteLength(scenario.args), deltaChars: scenario.deltaChars, snapshotOnly: !!scenario.snapshotOnly, packetBytes: scenario.packetBytes,
          upstreamFirstMs: rounded(h.upstreamTimes.firstDelta == null ? undefined : h.upstreamTimes.firstDelta - r.started), upstreamLastMs: rounded(h.upstreamTimes.lastDelta == null ? undefined : h.upstreamTimes.lastDelta - r.started),
          irFirstMs: rounded(h.irTimes.firstDelta == null ? undefined : h.irTimes.firstDelta - r.started), irLastMs: rounded(h.irTimes.lastDelta == null ? undefined : h.irTimes.lastDelta - r.started), irDeltas: h.irTimes.deltas,
          firstToolMs: rounded(r.firstToolMs), firstDeltaMs: rounded(r.firstDeltaMs), lastDeltaMs: rounded(r.lastDeltaMs), argsDoneMs: rounded(r.argsDoneMs), totalMs: rounded(r.totalMs), maxGapMs: rounded(r.maxGapMs), deltas: r.deltas,
          heapGrowthMiB: mib(heap - before.heapUsed), rssGrowthMiB: mib(rss - before.rss), terminal: r.terminal, error: r.error ?? null, exact: hash(args ?? "") === hash(scenario.args), hostedDispatches: h.dispatches.length }));
      } finally { clearInterval(sample); await h.close(); }
    }
  }
}
