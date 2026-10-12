import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { failureStatus } from "../src/core/proxy/errors";
import { UpstreamClient } from "../src/core/upstream/client";
import { EgressProxyPool } from "../src/core/upstream/egress/pool";
import type { EgressProxy } from "../src/core/upstream/egress/types";
import { answerLookup, SsrfGuard, type LookupCallback, type ResolvedAddress } from "../src/core/upstream/ssrf";

// --- C9: failureStatus stays inside the HTTP error range ---------------------

describe("C9: failureStatus maps an out-of-range status to the upstream-failure status", () => {
  const failed = (status: number) => ({ status, message: "m" });
  const rows: Array<[number, number]> = [
    [400, 400], [404, 404], [429, 429], [499, 499], [500, 500], [529, 529], [599, 599],
    [600, 502], [601, 502], [999, 502], [1000, 502], [65536, 502], [Infinity, 502],
    [399, 502], [200, 502], [0, 502], [-1, 502], [NaN, 502],
    [400.5, 502], [500.9, 502],
  ];
  it.each(rows)("%d -> %d", (status, expected) => {
    expect(failureStatus(failed(status))).toBe(expected);
  });
});

// --- C11: an empty validated-address list is refused on both paths -----------

describe("C11: a pinned lookup with no validated address fails closed", () => {
  type Answer = { err: Error | null; address: unknown };
  const answer = (run: (cb: LookupCallback) => void): Promise<Answer> =>
    new Promise((resolve) => run((err, address) => resolve({ err, address })));
  const noAddress = (): Error => new Error("no validated address");
  const ONE: ResolvedAddress[] = [{ address: "10.1.1.1", family: 4 }];

  it.each([[{ all: true }], [{ all: false }], [undefined]])("answerLookup with no address and options %j is an error", async (options) => {
    const got = await answer((cb) => answerLookup([], options, cb, noAddress));
    expect(got.err?.message).toBe("no validated address");
    expect(got.address).toBe("");
  });

  it("answerLookup with addresses is unchanged", async () => {
    expect(await answer((cb) => answerLookup(ONE, { all: true }, cb, noAddress))).toEqual({ err: null, address: ONE });
    expect(await answer((cb) => answerLookup(ONE, { all: false }, cb, noAddress))).toEqual({ err: null, address: "10.1.1.1" });
  });

  it.each([[{ all: true }], [{ all: false }]])("the direct client refuses an empty pin (options %j)", async (options) => {
    const client = new UpstreamClient(new SsrfGuard({ allowPrivate: true, allowlist: () => [] })) as unknown as {
      pinned: Map<string, { addresses: ResolvedAddress[]; expiresAt: number }>;
      lookupPinned(hostname: string, options: unknown, cb: LookupCallback): void;
    };
    client.pinned.set("empty.test", { addresses: [], expiresAt: Date.now() + 60_000 });
    const got = await answer((cb) => client.lookupPinned("empty.test", options, cb));
    expect(got.err?.message).toBe('no validated address for upstream host "empty.test"');
    expect(got.address).toBe("");
  });

  it.each([[{ all: true }], [{ all: false }]])("the proxy pool still refuses an empty pin (options %j)", async (options) => {
    const proxy: EgressProxy = { id: 1, name: "px", scheme: "http", host: "proxy.test", port: 7890, username: null, password: null };
    const pool = new EgressProxyPool() as unknown as { lookupPinned(entry: unknown, proxy: EgressProxy, h: string, o: unknown, cb: LookupCallback): void };
    const got = await answer((cb) => pool.lookupPinned({ addresses: [] }, proxy, "proxy.test", options, cb));
    expect(got.err?.message).toBe("no validated address for proxy px (http://proxy.test:7890)");
  });
});

// --- C10: postStream must give up at timeoutMs when no headers arrive --------

describe("C10: UpstreamClient.postStream time-to-first-headers", () => {
  let server: http.Server;
  let base: string;
  const held: http.ServerResponse[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      if (req.url === "/silent") {
        held.push(res); // accept the request, never answer
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(`data: ${sent++}\n\n`);
        if (sent === 5) {
          clearInterval(timer);
          res.end();
        }
      }, 150);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const res of held) res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = (): UpstreamClient => new UpstreamClient(new SsrfGuard({ allowPrivate: true, allowlist: () => [] }));

  // undici's own headersTimeout runs on a coarse timer: a 100 ms timeout used to
  // fire only after about a second.
  it.each([100, 400])("an upstream that never sends headers fails at timeoutMs=%i, not at the next coarse tick", async (timeoutMs) => {
    const started = Date.now();
    const err = await client().postStream(`${base}/silent`, {}, {}, { timeoutMs }).then(() => null, (e: unknown) => e as Error);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(Error);
    // What the step engine classifies as a timeout (execution/steps.ts).
    expect(err!.name === "TimeoutError" || /timed out|timeout/i.test(err!.message)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 20);
    expect(elapsed).toBeLessThan(timeoutMs + 300);
  });

  it("the caller's own abort still wins, with the caller's reason", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("client went away")), 50);
    await expect(client().postStream(`${base}/silent`, {}, {}, { timeoutMs: 5000, signal: controller.signal })).rejects.toThrow("client went away");
  });

  it("the headers deadline is not a total timeout: a stream that answered in time is not cut at timeoutMs", async () => {
    const timeoutMs = 300;
    const reply = await client().postStream(`${base}/chunks`, {}, {}, { timeoutMs });
    expect(reply.status).toBe(200);
    let text = "";
    for await (const chunk of reply.body) text += String(chunk);
    // five chunks 150 ms apart: 750 ms in all, each gap inside the idle timeout
    expect(text).toBe("data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n");
  });
});
