/**
 * Characterization of core/upstream and core/proxy ahead of their
 * de-duplication: the five UpstreamClient request methods and where they
 * differ, host resolution in the SSRF guard and the proxy-host guard, the
 * pinned-lookup answers, the round-trip's failure shapes, multipart field
 * surgery, and the per-family error frames, endpoint paths and auth headers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ default: { lookup: dnsLookup }, lookup: dnsLookup }));

import "../src/core/format";
import { UpstreamClient } from "../src/core/upstream/client";
import { SsrfGuard, UpstreamUrlError } from "../src/core/upstream/ssrf";
import { EgressProxyPool } from "../src/core/upstream/egress/pool";
import { resolveProxyHost } from "../src/core/upstream/egress/proxyHost";
import { proxyKey, proxyLabel, proxyOrigin, type EgressProxy } from "../src/core/upstream/egress/types";
import { relayStream, sendBuffered } from "../src/core/upstream/roundtrip";
import type { Transport, TransportJsonResult, TransportStreamResult } from "../src/core/upstream/transport";
import { buildHeaders, chatUrl, embeddingsUrl, imagesUrl, modelsUrl, rerankUrl, servesOpenAiMedia, speechUrl, transcriptionsUrl, videosUrl, type UpstreamProvider } from "../src/core/upstream/endpoints";
import { readMultipartField, rewriteMultipartField, upsertMultipartField } from "../src/core/upstream/multipart";
import { buildErrorBody, buildErrorFrame, extractUpstreamMessage, failureMessage, failureStatus, pingFrame } from "../src/core/proxy/errors";
import { parseRequest } from "../src/core/format";
import { FAMILIES, type Family } from "../src/core/ir/params";
import type { StreamEvent } from "../src/core/ir/stream";

// --- UpstreamClient ---------------------------------------------------------

interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }
let server: http.Server;
let base: string;
let seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const url = new URL(req.url ?? "/", "http://x");
      const status = Number(url.searchParams.get("status") ?? "200");
      const reply = url.searchParams.get("reply") ?? '{"ok":true}';
      if (url.pathname === "/slow-body") {
        // Headers at once, then a chunk every 20ms for ~400ms: never idle for long, but long in total.
        res.writeHead(status, { "content-type": "text/plain" });
        let sent = 0;
        const timer = setInterval(() => {
          if (res.destroyed) { clearInterval(timer); return; }
          res.write("x");
          if (++sent === 20) { clearInterval(timer); res.end(); }
        }, 20);
        res.on("close", () => clearInterval(timer));
        return;
      }
      if (url.pathname === "/slow-headers") {
        const timer = setTimeout(() => { res.writeHead(200); res.end("{}"); }, 400);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      res.writeHead(status, { "content-type": "application/json", "x-seen": "1" });
      res.end(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { seen = []; dnsLookup.mockReset(); });

const guard = (allowPrivate = true, allowlist: string[] = []): SsrfGuard => new SsrfGuard({ allowPrivate, allowlist: () => allowlist });
const readAll = async (body: AsyncIterable<Buffer | string>): Promise<string> => { let out = ""; for await (const c of body) out += c.toString(); return out; };
const failure = async (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error("expected a rejection"); }, (e: Error) => e);
const reply = (text: string, status = 200): string => `?status=${status}&reply=${encodeURIComponent(text)}`;
const OPTS = { timeoutMs: 5_000 };
const HEADERS = { "content-type": "application/json", "x-custom": "c" };

describe("UpstreamClient: the buffered methods", () => {
  it("postJson serializes the body, and reads a JSON reply as json + text", async () => {
    const client = new UpstreamClient(guard());
    const r = await client.postJson(`${base}/p${reply('{"a":1}')}`, HEADERS, { hello: "wörld" }, OPTS);
    expect(r.status).toBe(200); expect(r.json).toEqual({ a: 1 }); expect(r.text).toBe('{"a":1}'); expect(r.headers["x-seen"]).toBe("1");
    expect(Object.keys(r)).toEqual(["status", "headers", "json", "text"]);
    expect(seen[0].method).toBe("POST"); expect(seen[0].body).toBe('{"hello":"wörld"}'); expect(seen[0].headers["x-custom"]).toBe("c");
  });

  it("postRaw sends the body verbatim", async () => {
    const client = new UpstreamClient(guard());
    const r = await client.postRaw(`${base}/raw`, { "content-type": "multipart/form-data; boundary=b" }, Buffer.from("--b--\r\n"), OPTS);
    expect(r.json).toEqual({ ok: true }); expect(seen[0].method).toBe("POST"); expect(seen[0].body).toBe("--b--\r\n");
    await client.postRaw(`${base}/raw`, {}, "plain string", OPTS);
    expect(seen[1].body).toBe("plain string");
  });

  it("getJson sends no body", async () => {
    const client = new UpstreamClient(guard());
    const r = await client.getJson(`${base}/g${reply('[1,2]')}`, { authorization: "Bearer k" }, OPTS);
    expect(r.json).toEqual([1, 2]); expect(r.text).toBe("[1,2]"); expect(seen[0].method).toBe("GET"); expect(seen[0].body).toBe(""); expect(seen[0].headers.authorization).toBe("Bearer k");
    expect(Object.keys(r)).toEqual(["status", "headers", "json", "text"]);
  });

  it("an unparseable 2xx body is json:undefined on the POSTs and a thrown error on getJson", async () => {
    const client = new UpstreamClient(guard());
    const url = `${base}/bad${reply("<html>")}`;
    const posted = await client.postJson(url, HEADERS, {}, OPTS);
    expect(posted.json).toBeUndefined(); expect(posted.text).toBe("<html>"); expect(posted.status).toBe(200);
    const raw = await client.postRaw(url, HEADERS, "x", OPTS);
    expect(raw.json).toBeUndefined(); expect(raw.text).toBe("<html>");
    const thrown = await failure(client.getJson(url, {}, OPTS));
    expect(thrown.message).toBe("upstream returned invalid JSON"); expect(thrown.name).toBe("Error");
  });

  it("an unparseable error body is json:undefined on all three", async () => {
    const client = new UpstreamClient(guard());
    const url = `${base}/bad${reply("gateway down", 502)}`;
    for (const r of [await client.postJson(url, HEADERS, {}, OPTS), await client.postRaw(url, HEADERS, "x", OPTS), await client.getJson(url, {}, OPTS)]) {
      expect(r.status).toBe(502); expect(r.json).toBeUndefined(); expect(r.text).toBe("gateway down");
    }
    const edge = await client.getJson(`${base}/bad${reply("nope", 300)}`, {}, OPTS);
    expect(edge.status).toBe(300); expect(edge.json).toBeUndefined();
    await expect(client.getJson(`${base}/bad${reply("nope", 299)}`, {}, OPTS)).rejects.toThrow("upstream returned invalid JSON");
  });

  it("an empty body is json:undefined and text:'' everywhere, without throwing", async () => {
    const client = new UpstreamClient(guard());
    const url = `${base}/empty${reply("")}`;
    for (const r of [await client.postJson(url, HEADERS, {}, OPTS), await client.postRaw(url, HEADERS, "x", OPTS), await client.getJson(url, {}, OPTS)]) {
      expect(r.json).toBeUndefined(); expect(r.text).toBe("");
    }
  });

  it("a JSON error body is parsed on every method", async () => {
    const client = new UpstreamClient(guard());
    const url = `${base}/e${reply('{"error":{"message":"no"}}', 429)}`;
    for (const r of [await client.postJson(url, HEADERS, {}, OPTS), await client.postRaw(url, HEADERS, "x", OPTS), await client.getJson(url, {}, OPTS)]) {
      expect(r.status).toBe(429); expect(r.json).toEqual({ error: { message: "no" } });
    }
  });
});

describe("UpstreamClient: the streamed methods and the total timeout", () => {
  it("postStream and getStream return status, headers and the raw body", async () => {
    const client = new UpstreamClient(guard());
    const posted = await client.postStream(`${base}/s${reply("data: 1\n\n")}`, HEADERS, { a: 1 }, OPTS);
    expect(Object.keys(posted)).toEqual(["status", "headers", "body"]);
    expect(posted.status).toBe(200); expect(await readAll(posted.body)).toBe("data: 1\n\n"); expect(seen[0].method).toBe("POST"); expect(seen[0].body).toBe('{"a":1}');
    const got = await client.getStream(`${base}/s${reply("bytes", 404)}`, { accept: "*/*" }, OPTS);
    expect(Object.keys(got)).toEqual(["status", "headers", "body"]);
    expect(got.status).toBe(404); expect(await readAll(got.body)).toBe("bytes"); expect(seen[1].method).toBe("GET"); expect(seen[1].body).toBe("");
  });

  it("postStream has no total timeout: a body that keeps streaming past timeoutMs is read whole", async () => {
    const client = new UpstreamClient(guard());
    const r = await client.postStream(`${base}/slow-body`, HEADERS, {}, { timeoutMs: 150 });
    expect(await readAll(r.body)).toBe("x".repeat(20));
  });

  it("getStream, postJson, postRaw and getJson are cut off at timeoutMs in total", async () => {
    const client = new UpstreamClient(guard());
    const stream = await client.getStream(`${base}/slow-body`, {}, { timeoutMs: 150 });
    expect((await failure(readAll(stream.body))).name).toBe("TimeoutError");
    expect((await failure(client.postJson(`${base}/slow-body`, HEADERS, {}, { timeoutMs: 150 }))).name).toBe("TimeoutError");
    expect((await failure(client.postRaw(`${base}/slow-body`, HEADERS, "x", { timeoutMs: 150 }))).name).toBe("TimeoutError");
    expect((await failure(client.getJson(`${base}/slow-body`, {}, { timeoutMs: 150 }))).name).toBe("TimeoutError");
  });

  it("the four methods with a total timeout give up on headers that do not arrive within timeoutMs", async () => {
    const client = new UpstreamClient(guard());
    const url = `${base}/slow-headers`;
    const opts = { timeoutMs: 100 };
    for (const attempt of [client.postJson(url, HEADERS, {}, opts), client.postRaw(url, HEADERS, "x", opts), client.getJson(url, {}, opts), client.getStream(url, {}, opts)]) {
      expect((await failure(attempt)).name).toBe("TimeoutError");
    }
  });

  it("an external signal aborts every method", async () => {
    const client = new UpstreamClient(guard());
    const url = `${base}/slow-headers`;
    for (const start of [
      (signal: AbortSignal) => client.postJson(url, HEADERS, {}, { timeoutMs: 5_000, signal }),
      (signal: AbortSignal) => client.postRaw(url, HEADERS, "x", { timeoutMs: 5_000, signal }),
      (signal: AbortSignal) => client.getJson(url, {}, { timeoutMs: 5_000, signal }),
      (signal: AbortSignal) => client.getStream(url, {}, { timeoutMs: 5_000, signal }),
      (signal: AbortSignal) => client.postStream(url, HEADERS, {}, { timeoutMs: 5_000, signal }),
    ]) {
      const controller = new AbortController();
      const pending = failure(start(controller.signal));
      setTimeout(() => controller.abort(), 20);
      expect((await pending).name).toBe("AbortError");
    }
  });
});

const PROXY: EgressProxy = { id: 1, name: "px", scheme: "http", host: "127.0.0.1", port: 7890, username: null, password: null };

describe("UpstreamClient: URL validation on the direct and the proxied path", () => {
  const methods = (client: UpstreamClient, url: string, proxy?: EgressProxy): Array<Promise<unknown>> => {
    const opts = { timeoutMs: 1_000, proxy };
    return [client.postJson(url, {}, {}, opts), client.postStream(url, {}, {}, opts), client.postRaw(url, {}, "x", opts), client.getStream(url, {}, opts), client.getJson(url, {}, opts)];
  };

  it("rejects a malformed URL and a non-http scheme with the same text on both paths", async () => {
    const pool = new EgressProxyPool();
    try {
      for (const proxy of [undefined, PROXY]) {
        const client = new UpstreamClient(guard(), pool);
        for (const attempt of methods(client, "not a url", proxy)) {
          const e = await failure(attempt);
          expect(e).toBeInstanceOf(UpstreamUrlError); expect(e.message).toBe("invalid upstream URL: not a url");
        }
        for (const attempt of methods(client, "ftp://host/x", proxy)) {
          const e = await failure(attempt);
          expect(e).toBeInstanceOf(UpstreamUrlError); expect(e.message).toBe('unsupported upstream URL scheme "ftp:" (use http/https)');
        }
      }
    } finally { await pool.closeAll(); }
  });

  it("refuses a proxied request when no pool was given, before looking at the URL", async () => {
    for (const attempt of methods(new UpstreamClient(guard()), "not a url", PROXY)) {
      const e = await failure(attempt);
      expect(e).toBeInstanceOf(UpstreamUrlError); expect(e.message).toBe("this provider is configured to use a proxy, but no proxy pool is available");
    }
  });

  it("the direct path refuses a blocked address; nothing is sent", async () => {
    const e = await failure(new UpstreamClient(guard(false)).postJson(`${base}/x`, {}, {}, OPTS));
    expect(e).toBeInstanceOf(UpstreamUrlError); expect(e.message).toContain('upstream host "127.0.0.1" resolves to a disallowed address (127.0.0.1).');
    expect(seen).toEqual([]);
  });
});

// --- host resolution --------------------------------------------------------

describe("host resolution: SsrfGuard and the proxy-host guard", () => {
  it("a literal IP is not looked up", async () => {
    expect(await guard().validateHost("10.0.0.5")).toEqual([{ address: "10.0.0.5", family: 4 }]);
    expect(await guard(true, ["::1"]).validateHost("::1")).toEqual([{ address: "::1", family: 6 }]);
    expect(await resolveProxyHost({ ...PROXY, host: "10.0.0.5" })).toEqual([{ address: "10.0.0.5", family: 4 }]);
    expect(await resolveProxyHost({ ...PROXY, host: " [::1] " })).toEqual([{ address: "::1", family: 6 }]);
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it("a hostname is resolved with all addresses, verbatim order, and mapped by family", async () => {
    dnsLookup.mockResolvedValue([{ address: "2001:db8::1", family: 6 }, { address: "93.184.216.34", family: 4 }]);
    expect(await guard().validateHost("example.test")).toEqual([{ address: "2001:db8::1", family: 6 }, { address: "93.184.216.34", family: 4 }]);
    expect(dnsLookup).toHaveBeenLastCalledWith("example.test", { all: true, verbatim: true });
    expect(await resolveProxyHost({ ...PROXY, host: " Proxy.Example.TEST " })).toEqual([{ address: "2001:db8::1", family: 6 }, { address: "93.184.216.34", family: 4 }]);
    expect(dnsLookup).toHaveBeenLastCalledWith("proxy.example.test", { all: true, verbatim: true });
  });

  it("a lookup that throws: each guard's own wording", async () => {
    dnsLookup.mockRejectedValue(new Error("ENOTFOUND"));
    const upstream = await failure(guard().validateHost("gone.test"));
    expect(upstream).toBeInstanceOf(UpstreamUrlError); expect(upstream.message).toBe('cannot resolve upstream host "gone.test"');
    const proxy = await failure(resolveProxyHost({ ...PROXY, host: "gone.test" }));
    expect(proxy).toBeInstanceOf(UpstreamUrlError); expect(proxy.message).toBe('cannot resolve proxy host "gone.test" (proxy "px")');
  });

  it("a lookup that answers with nothing: each guard's own wording", async () => {
    dnsLookup.mockResolvedValue([]);
    expect((await failure(guard().validateHost("empty.test"))).message).toBe('upstream host "empty.test" did not resolve');
    expect((await failure(resolveProxyHost({ ...PROXY, host: "empty.test" }))).message).toBe('proxy host "empty.test" did not resolve');
  });

  it("resolveAllowed lowercases the host and strips IPv6 brackets", async () => {
    dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    expect(await guard().resolveAllowed("https://EXAMPLE.Test:8443/v1?x=1")).toEqual({ host: "example.test", addresses: [{ address: "93.184.216.34", family: 4 }] });
    expect(await guard(true, ["2001:db8::2"]).resolveAllowed("http://[2001:DB8::2]:80/")).toEqual({ host: "2001:db8::2", addresses: [{ address: "2001:db8::2", family: 6 }] });
    expect((await failure(guard().resolveAllowed("::::"))).message).toBe("invalid upstream URL: ::::");
    expect((await failure(guard().resolveAllowed("file:///etc/passwd"))).message).toBe('unsupported upstream URL scheme "file:" (use http/https)');
  });

  it("the proxy-host guard checks port and host before resolving", async () => {
    expect((await failure(resolveProxyHost({ ...PROXY, port: 0 }))).message).toBe("proxy px (http://127.0.0.1:0) has an invalid port");
    expect((await failure(resolveProxyHost({ ...PROXY, port: 65536 }))).message).toBe("proxy px (http://127.0.0.1:65536) has an invalid port");
    expect((await failure(resolveProxyHost({ ...PROXY, port: 22 }))).message).toBe("proxy px (http://127.0.0.1:22) uses port 22, which is not a proxy port");
    expect((await failure(resolveProxyHost({ ...PROXY, host: "  " }))).message).toBe('proxy "px" has no host');
    expect((await failure(resolveProxyHost({ ...PROXY, host: "[]" }))).message).toBe('proxy "px" has no host');
    expect((await failure(resolveProxyHost({ ...PROXY, host: "169.254.169.254" }))).message).toContain("proxy px (http://169.254.169.254:7890) resolves to a disallowed address (169.254.169.254).");
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it("proxy identity helpers treat the host's brackets and case as they did", () => {
    expect(proxyOrigin({ ...PROXY, host: " [::1] " })).toBe("http://[::1]:7890");
    expect(proxyOrigin({ ...PROXY, host: "::1" })).toBe("http://[::1]:7890");
    expect(proxyOrigin({ ...PROXY, host: "Proxy.Test", scheme: "https" })).toBe("https://Proxy.Test:7890");
    expect(proxyLabel({ ...PROXY, host: "[::1]" })).toBe("px (http://[::1]:7890)");
    expect(proxyKey({ ...PROXY, host: "[::1]", username: "u", password: "p" })).toMatch(/^http:\/\/u@\[::1\]:7890#[0-9a-f]+$/);
  });
});

// --- pinned lookup answers --------------------------------------------------

type LookupCb = (err: Error | null, address?: unknown, family?: number) => void;
const answer = (run: (cb: LookupCb) => void): Promise<{ err: Error | null; address?: unknown; family?: number }> =>
  new Promise((resolve) => run((err, address, family) => resolve({ err, address, family })));

describe("pinned DNS lookup answers", () => {
  const ADDRESSES = [{ address: "10.1.1.1", family: 4 as const }, { address: "fd00::1", family: 6 as const }];

  it("the direct client answers from its pin: every address for `all`, else the first", async () => {
    const client = new UpstreamClient(guard()) as unknown as { pinned: Map<string, unknown>; lookupPinned(h: string, o: unknown, cb: LookupCb): void };
    client.pinned.set("up.test", { addresses: ADDRESSES, expiresAt: Date.now() + 60_000 });
    expect(await answer((cb) => client.lookupPinned("UP.test", { all: true }, cb))).toEqual({ err: null, address: ADDRESSES, family: undefined });
    expect(await answer((cb) => client.lookupPinned("up.test", { all: false }, cb))).toEqual({ err: null, address: "10.1.1.1", family: 4 });
    expect(await answer((cb) => client.lookupPinned("up.test", undefined, cb))).toEqual({ err: null, address: "10.1.1.1", family: 4 });
    client.pinned.set("none.test", { addresses: [], expiresAt: Date.now() + 60_000 });
    for (const options of [{ all: true }, {}]) {
      const empty = await answer((cb) => client.lookupPinned("none.test", options, cb));
      expect(empty.err?.message).toBe('no validated address for upstream host "none.test"'); expect(empty.address).toBe("");
    }
  });

  it("the proxy pool answers only for its own proxy host, and never with an empty list", async () => {
    const pool = new EgressProxyPool() as unknown as { lookupPinned(entry: unknown, proxy: EgressProxy, h: string, o: unknown, cb: LookupCb): void };
    const proxy = { ...PROXY, host: " [FD00::1] " };
    const entry = { addresses: ADDRESSES };
    expect(await answer((cb) => pool.lookupPinned(entry, proxy, "fd00::1", { all: true }, cb))).toEqual({ err: null, address: ADDRESSES, family: undefined });
    expect(await answer((cb) => pool.lookupPinned(entry, proxy, "FD00::1", { all: false }, cb))).toEqual({ err: null, address: "10.1.1.1", family: 4 });
    expect(await answer((cb) => pool.lookupPinned(entry, proxy, "fd00::1", undefined, cb))).toEqual({ err: null, address: "10.1.1.1", family: 4 });
    const other = await answer((cb) => pool.lookupPinned(entry, proxy, "evil.test", { all: true }, cb));
    expect(other.err?.message).toBe('proxy dispatcher asked to resolve "evil.test", which is not proxy px (http://[FD00::1]:7890)'); expect(other.address).toBe("");
    for (const options of [{ all: true }, { all: false }]) {
      const none = await answer((cb) => pool.lookupPinned({ addresses: [] }, proxy, "fd00::1", options, cb));
      expect(none.err?.message).toBe("no validated address for proxy px (http://[FD00::1]:7890)"); expect(none.address).toBe("");
    }
  });
});

// --- round trip -------------------------------------------------------------

const TARGET = { upstreamModel: "up", url: "http://up.test/v1", headers: { h: "1" }, timeoutMs: 1234, signal: new AbortController().signal, proxy: PROXY };

function fakeTransport(replies: { json?: Partial<TransportJsonResult>; stream?: { status: number; chunks: string[] } }): Transport & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async postJson(...args) { calls.push(["postJson", ...args]); return { status: 200, headers: {}, json: undefined, text: "", ...replies.json }; },
    async postStream(...args): Promise<TransportStreamResult> { calls.push(["postStream", ...args]); return { status: replies.stream!.status, headers: {}, body: Readable.from(replies.stream!.chunks) }; },
  };
}
const request = (family: Family, stream: boolean) => {
  const body = family === "openai_responses" ? { model: "svc", input: "hi", stream } : { model: "svc", messages: [{ role: "user", content: "hi" }], stream, ...(family === "anthropic" ? { max_tokens: 5 } : {}) };
  return parseRequest(family, body);
};
const VALID_BODY: Record<Family, Record<string, unknown>> = {
  openai_completion: { id: "c", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
  anthropic: { id: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
  openai_responses: { id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] },
};
const DONE_STREAM: Record<Family, string[]> = {
  openai_completion: ['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"],
  anthropic: ['data: {"type":"message_start","message":{"id":"m"}}\n\n', 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n', 'data: {"type":"message_stop"}\n\n'],
  openai_responses: ['data: {"type":"response.output_text.delta","delta":"ok"}\n\n', 'data: {"type":"response.completed","response":{}}\n\n'],
};
const OPTIONS = { timeoutMs: 1234, signal: TARGET.signal, proxy: PROXY };

describe("round trip: sendBuffered (buffered JSON)", () => {
  for (const family of FAMILIES) {
    it(`${family}: a valid body parses; the transport is called once with the rendered body and the target's options`, async () => {
      const transport = fakeTransport({ json: { json: VALID_BODY[family] } });
      const req = request(family, false);
      const r = await sendBuffered(req, transport, TARGET);
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.response.text()).toBe("ok"); expect(r.response.family).toBe(family); expect(r.sentBody).toEqual(req.render(TARGET)); expect(Object.keys(r)).toEqual(["ok", "response", "sentBody"]); }
      expect(transport.calls).toEqual([["postJson", TARGET.url, TARGET.headers, req.render(TARGET), OPTIONS]]);
    });

    it(`${family}: a non-2xx reply is the upstream's status with its json, else its text`, async () => {
      const req = request(family, false);
      const sentBody = req.render(TARGET);
      const withJson = await sendBuffered(req, fakeTransport({ json: { status: 429, json: { error: { message: "slow down" } }, text: "ignored" } }), TARGET);
      expect(withJson).toEqual({ ok: false, status: 429, kind: "http", message: "upstream returned 429", body: { error: { message: "slow down" } }, sentBody });
      expect(Object.keys(withJson)).toEqual(["ok", "status", "kind", "message", "body", "sentBody"]);
      const withText = await sendBuffered(req, fakeTransport({ json: { status: 503, json: undefined, text: "down" } }), TARGET);
      expect(withText).toEqual({ ok: false, status: 503, kind: "http", message: "upstream returned 503", body: "down", sentBody });
      const edge = await sendBuffered(req, fakeTransport({ json: { status: 300, json: null, text: "" } }), TARGET);
      expect(edge).toEqual({ ok: false, status: 300, kind: "http", message: "upstream returned 300", body: "", sentBody });
      expect((await sendBuffered(req, fakeTransport({ json: { status: 199, json: 0, text: "t" } }), TARGET) as { body: unknown }).body).toBe(0);
    });

    it(`${family}: a 2xx that is not a JSON object is a 502 without a body`, async () => {
      const req = request(family, false);
      for (const json of [undefined, null, "text", 5, [VALID_BODY[family]]]) {
        const r = await sendBuffered(req, fakeTransport({ json: { json } }), TARGET);
        expect(r).toEqual({ ok: false, status: 502, kind: "http", message: "upstream returned empty or invalid JSON body", sentBody: req.render(TARGET) });
        expect(Object.keys(r)).toEqual(["ok", "status", "kind", "message", "sentBody"]);
      }
    });

    it(`${family}: a 2xx carrying an error is a 502 with the error's message`, async () => {
      const req = request(family, false);
      const sentBody = req.render(TARGET);
      const named = { ...VALID_BODY[family], error: { message: "model overloaded" } };
      expect(await sendBuffered(req, fakeTransport({ json: { json: named } }), TARGET)).toEqual({ ok: false, status: 502, kind: "http", message: "model overloaded", body: named, sentBody });
      for (const error of ["a string", { code: 1 }, { message: 5 }, 0, false]) {
        const body = { ...VALID_BODY[family], error };
        const r = await sendBuffered(req, fakeTransport({ json: { json: body } }), TARGET);
        expect(r).toEqual({ ok: false, status: 502, kind: "http", message: "upstream response did not complete", body, sentBody });
        expect(Object.keys(r)).toEqual(["ok", "status", "kind", "message", "body", "sentBody"]);
      }
      const nullError = await sendBuffered(req, fakeTransport({ json: { json: { ...VALID_BODY[family], error: null } } }), TARGET);
      expect(nullError.ok).toBe(true);
    });

    it(`${family}: a 2xx without the family's envelope is a 502 naming the family`, async () => {
      const req = request(family, false);
      const body = { id: "x", object: "something else" };
      expect(await sendBuffered(req, fakeTransport({ json: { json: body } }), TARGET)).toEqual({ ok: false, status: 502, kind: "http", message: `upstream returned invalid ${family} response`, body, sentBody: req.render(TARGET) });
    });
  }

  it("each family's envelope is its own: another family's body is invalid", async () => {
    const accepted: string[] = [];
    for (const family of FAMILIES) {
      for (const shape of FAMILIES) {
        const r = await sendBuffered(request(family, false), fakeTransport({ json: { json: VALID_BODY[shape] } }), TARGET);
        if (r.ok) accepted.push(`${family}<-${shape}`);
      }
    }
    expect(accepted).toEqual(["openai_completion<-openai_completion", "anthropic<-anthropic", "openai_responses<-openai_responses"]);
    for (const [family, body, ok] of [
      ["openai_completion", { choices: [] }, false], ["openai_completion", { choices: "x" }, false], ["openai_completion", { choices: [null] }, true],
      ["anthropic", { content: [] }, true], ["anthropic", { content: "text" }, false],
      ["openai_responses", { output: [] }, true], ["openai_responses", { output: {} }, false],
    ] as Array<[Family, Record<string, unknown>, boolean]>) {
      expect((await sendBuffered(request(family, false), fakeTransport({ json: { json: body } }), TARGET)).ok, `${family} ${JSON.stringify(body)}`).toBe(ok);
    }
  });

  it("only a Responses body is judged by its status", async () => {
    for (const status of ["failed", "cancelled", "queued", "in_progress"]) {
      const body = { ...VALID_BODY.openai_responses, status };
      const req = request("openai_responses", false);
      expect(await sendBuffered(req, fakeTransport({ json: { json: body } }), TARGET)).toEqual({ ok: false, status: 502, kind: "http", message: "upstream response did not complete", body, sentBody: req.render(TARGET) });
      for (const family of ["openai_completion", "anthropic"] as const) {
        expect((await sendBuffered(request(family, false), fakeTransport({ json: { json: { ...VALID_BODY[family], status } } }), TARGET)).ok).toBe(true);
      }
    }
    for (const status of ["completed", "incomplete", "weird", undefined]) {
      expect((await sendBuffered(request("openai_responses", false), fakeTransport({ json: { json: { ...VALID_BODY.openai_responses, status } } }), TARGET)).ok).toBe(true);
    }
    // The status is read before the envelope: an unfinished body with no output is "did not complete", not "invalid".
    const r = await sendBuffered(request("openai_responses", false), fakeTransport({ json: { json: { status: "queued" } } }), TARGET);
    expect((r as { message: string }).message).toBe("upstream response did not complete");
  });
});

describe("round trip: the streamed paths", () => {
  for (const family of FAMILIES) {
    it(`${family}: sendBuffered with stream:true collects the stream`, async () => {
      const transport = fakeTransport({ stream: { status: 200, chunks: DONE_STREAM[family] } });
      const req = request(family, true);
      const r = await sendBuffered(req, transport, TARGET);
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.response.text()).toBe("ok"); expect(r.response.family).toBe(family); expect(r.sentBody).toEqual(req.render(TARGET)); }
      expect(transport.calls).toEqual([["postStream", TARGET.url, TARGET.headers, req.render(TARGET), OPTIONS]]);
    });

    it(`${family}: a truncated stream is a 502 without a body`, async () => {
      const req = request(family, true);
      const r = await sendBuffered(req, fakeTransport({ stream: { status: 200, chunks: DONE_STREAM[family].slice(0, 1).map(c => c.replace(',"finish_reason":"stop"', "")) } }), TARGET);
      expect(r).toEqual({ ok: false, status: 502, kind: "http", message: "upstream stream ended before completion (truncated)", sentBody: req.render(TARGET) });
      expect(Object.keys(r)).toEqual(["ok", "status", "kind", "message", "sentBody"]);
    });

    it(`${family}: a non-2xx stream is drained into the failure body, on send and on relay`, async () => {
      const req = request(family, true);
      const sentBody = req.render(TARGET);
      const json = await sendBuffered(req, fakeTransport({ stream: { status: 500, chunks: ['{"error":', '{"message":"boom"}}'] } }), TARGET);
      expect(json).toEqual({ ok: false, status: 500, kind: "http", message: "upstream returned 500", body: { error: { message: "boom" } }, sentBody });
      expect(Object.keys(json)).toEqual(["ok", "status", "kind", "message", "body", "sentBody"]);
      const text = await relayStream(req, fakeTransport({ stream: { status: 404, chunks: ["not ", "json"] } }), TARGET);
      expect(text).toEqual({ ok: false, status: 404, kind: "http", message: "upstream returned 404", body: "not json", sentBody });
      const empty = await relayStream(req, fakeTransport({ stream: { status: 302, chunks: [] } }), TARGET);
      expect(empty).toEqual({ ok: false, status: 302, kind: "http", message: "upstream returned 302", body: "", sentBody });
    });

    it(`${family}: relay always renders stream:true and hands back the live events`, async () => {
      const req = request(family, false);
      const transport = fakeTransport({ stream: { status: 201, chunks: DONE_STREAM[family] } });
      const r = await relayStream(req, transport, TARGET);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(Object.keys(r)).toEqual(["ok", "status", "events", "sentBody"]);
      expect(r.status).toBe(201); expect(r.sentBody.stream).toBe(true); expect(r.sentBody).toEqual(req.withStream(true).render(TARGET));
      expect(transport.calls).toEqual([["postStream", TARGET.url, TARGET.headers, r.sentBody, OPTIONS]]);
      const events: StreamEvent[] = [];
      for await (const ev of r.events) events.push(ev);
      expect(events.filter(e => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "ok" }]);
      expect(events.at(-1)?.type).toBe("finish");
    });
  }

  it("an error body split inside a multi-byte character is decoded whole", async () => {
    const bytes = Buffer.from('{"error":{"message":"日本語"}}', "utf8");
    const transport: Transport = {
      async postJson() { throw new Error("unused"); },
      async postStream() { return { status: 500, headers: {}, body: Readable.from([bytes.subarray(0, 22), bytes.subarray(22)]) }; },
    };
    const r = await relayStream(request("openai_completion", true), transport, TARGET);
    expect((r as { body: unknown }).body).toEqual({ error: { message: "日本語" } });
  });

  it("an error body whose stream fails midway keeps what was read", async () => {
    async function* broken(): AsyncGenerator<string> { yield "partial"; throw new Error("reset"); }
    const transport: Transport = {
      async postJson() { throw new Error("unused"); },
      async postStream() { return { status: 500, headers: {}, body: broken() as unknown as Readable }; },
    };
    expect((await relayStream(request("openai_completion", true), transport, TARGET) as { body: unknown }).body).toBe("partial");
  });
});

// --- per-family error frames, endpoints, auth -------------------------------

const UNKNOWN = "something_new" as Family;

describe("client error bodies and in-stream frames, per family", () => {
  it("builds each family's error body", () => {
    expect(JSON.stringify(buildErrorBody("openai_completion", 429, "slow"))).toBe('{"error":{"message":"slow","type":"rate_limit_error","code":null,"param":null}}');
    expect(JSON.stringify(buildErrorBody("openai_responses", 500, "boom"))).toBe('{"error":{"message":"boom","type":"server_error","code":null,"param":null}}');
    expect(JSON.stringify(buildErrorBody("anthropic", 529, "busy"))).toBe('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}');
    expect(JSON.stringify(buildErrorBody(UNKNOWN, 401, "who"))).toBe('{"error":{"message":"who","type":"authentication_error","code":null,"param":null}}');
  });

  it("maps a status to each wire's error type", () => {
    const type = (family: Family, status: number): unknown => ((buildErrorBody(family, status, "m").error) as { type: string }).type;
    expect([401, 403, 429, 500, 502, 599, 400, 404, 422, 499, 200, 302, 0].map(s => type("openai_completion", s))).toEqual([
      "authentication_error", "authentication_error", "rate_limit_error", "server_error", "server_error", "server_error",
      "invalid_request_error", "invalid_request_error", "invalid_request_error", "invalid_request_error", "api_error", "api_error", "api_error"]);
    expect([400, 401, 403, 404, 429, 529, 500, 502, 422, 409, 200, 0].map(s => type("anthropic", s))).toEqual([
      "invalid_request_error", "authentication_error", "permission_error", "not_found_error", "rate_limit_error", "overloaded_error",
      "api_error", "api_error", "invalid_request_error", "invalid_request_error", "invalid_request_error", "invalid_request_error"]);
  });

  it("frames a mid-stream error the way each wire's clients read it", () => {
    expect(buildErrorFrame("openai_completion", 502, "bad")).toBe('data: {"error":{"message":"bad","type":"server_error","code":null,"param":null}}\n\n');
    expect(buildErrorFrame("openai_responses", 502, "bad")).toBe('event: error\ndata: {"error":{"message":"bad","type":"server_error","code":null,"param":null}}\n\n');
    expect(buildErrorFrame("anthropic", 502, "bad")).toBe('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"bad"}}\n\n');
    expect(buildErrorFrame(UNKNOWN, 502, "bad")).toBe('data: {"error":{"message":"bad","type":"server_error","code":null,"param":null}}\n\n');
  });

  it("pings with an event on Anthropic and an SSE comment elsewhere", () => {
    expect(pingFrame("anthropic")).toBe('event: ping\ndata: {"type":"ping"}\n\n');
    expect(pingFrame("openai_completion")).toBe(": ping\n\n");
    expect(pingFrame("openai_responses")).toBe(": ping\n\n");
    expect(pingFrame(UNKNOWN)).toBe(": ping\n\n");
  });

  it("maps a failed attempt to a status and a message", () => {
    const f = (status: number, errorBody?: unknown) => ({ ok: false as const, status, kind: "http" as const, message: "transport said", errorBody });
    expect([400, 404, 499, 500, 599, 600, 0, 200, 302, 399, -1].map(s => failureStatus(f(s)))).toEqual([400, 404, 499, 500, 599, 502, 502, 502, 502, 502, 502]);
    expect(failureMessage(f(500, { error: { message: "from body" } }))).toBe("from body");
    expect(failureMessage(f(500, { error: "string error" }))).toBe("string error");
    expect(failureMessage(f(500, { message: "top level" }))).toBe("top level");
    expect(failureMessage(f(500, { error: { code: 1 } }))).toBe("transport said");
    expect(failureMessage(f(500, ""))).toBe("transport said");
    expect(failureMessage(f(500))).toBe("transport said");
    expect(failureMessage(f(500, "x".repeat(600)))).toBe("x".repeat(500));
    expect(extractUpstreamMessage(["array"])).toBeNull();
  });
});

describe("upstream endpoints and auth, per family", () => {
  const provider = (type: Family, extra: Partial<UpstreamProvider> = {}): UpstreamProvider => ({ type, baseUrl: "https://api.test/v1//", apiKey: "sk-1", ...extra });

  it("puts the chat and model-list endpoints where each family serves them", () => {
    expect(FAMILIES.map(f => chatUrl(provider(f)))).toEqual(["https://api.test/v1/chat/completions", "https://api.test/v1/v1/messages", "https://api.test/v1/responses"]);
    expect(FAMILIES.map(f => modelsUrl(provider(f)))).toEqual(["https://api.test/v1/models", "https://api.test/v1/v1/models", "https://api.test/v1/models"]);
    expect(chatUrl(provider(UNKNOWN))).toBe("https://api.test/v1/chat/completions");
    expect(modelsUrl(provider(UNKNOWN))).toBe("https://api.test/v1/models");
    expect(chatUrl(provider("anthropic", { baseUrl: "https://bare.test" }))).toBe("https://bare.test/v1/messages");
  });

  it("serves the OpenAI media surface on the two OpenAI families only", () => {
    expect(FAMILIES.map(servesOpenAiMedia)).toEqual([true, false, true]);
    expect(servesOpenAiMedia(UNKNOWN)).toBe(true);
    const p = provider("openai_completion");
    expect([embeddingsUrl(p), imagesUrl(p), speechUrl(p), transcriptionsUrl(p), rerankUrl(p), videosUrl(p), videosUrl(p, "/v_1/content")]).toEqual([
      "https://api.test/v1/embeddings", "https://api.test/v1/images/generations", "https://api.test/v1/audio/speech", "https://api.test/v1/audio/transcriptions",
      "https://api.test/v1/rerank", "https://api.test/v1/videos", "https://api.test/v1/videos/v_1/content"]);
  });

  it("writes each family's auth after the provider's own headers, in a fixed order", () => {
    const extraHeaders = { "X-Org": "o", Authorization: "Bearer injected", "X-Api-Key": "injected", Host: "evil", "Anthropic-Version": "1999" };
    expect(Object.entries(buildHeaders(provider("openai_completion", { extraHeaders })))).toEqual([
      ["content-type", "application/json"], ["x-org", "o"], ["authorization", "Bearer sk-1"], ["x-api-key", "injected"], ["anthropic-version", "1999"]]);
    expect(Object.entries(buildHeaders(provider("openai_responses", { extraHeaders })))).toEqual([
      ["content-type", "application/json"], ["x-org", "o"], ["authorization", "Bearer sk-1"], ["x-api-key", "injected"], ["anthropic-version", "1999"]]);
    expect(Object.entries(buildHeaders(provider("anthropic", { extraHeaders })))).toEqual([
      ["content-type", "application/json"], ["x-org", "o"], ["authorization", "Bearer injected"], ["x-api-key", "sk-1"], ["anthropic-version", "2023-06-01"]]);
    expect(Object.entries(buildHeaders(provider(UNKNOWN)))).toEqual([["content-type", "application/json"], ["authorization", "Bearer sk-1"]]);
  });

  it("sends no key header without a key, but always the Anthropic version; per-call headers win last", () => {
    expect(buildHeaders(provider("openai_completion", { apiKey: null }))).toEqual({ "content-type": "application/json" });
    expect(buildHeaders(provider("openai_responses", { apiKey: "" }))).toEqual({ "content-type": "application/json" });
    expect(buildHeaders(provider("anthropic", { apiKey: null }))).toEqual({ "content-type": "application/json", "anthropic-version": "2023-06-01" });
    expect(buildHeaders(provider("anthropic"), { "Anthropic-Beta": "b", "X-API-Key": "per-call" })).toEqual({ "content-type": "application/json", "x-api-key": "per-call", "anthropic-version": "2023-06-01", "anthropic-beta": "b" });
  });
});

// --- multipart --------------------------------------------------------------

describe("multipart field surgery", () => {
  const CT = "multipart/form-data; boundary=XYZ";
  const body = (...parts: string[]): Buffer => Buffer.from(parts.map(p => `--XYZ\r\n${p}\r\n`).join("") + "--XYZ--\r\n", "utf8");
  const field = (name: string, value: string): string => `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`;
  const file = (name: string, content: string): string => `Content-Disposition: form-data; name="${name}"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n${content}`;
  const FORM = body(file("file", "RIFF--XYZ-not-a-delimiter"), field("model", " whisper-1 "), field("language", "en"));

  it("reads a text field, trimmed; a file part of the same name is not one", () => {
    expect(readMultipartField(FORM, CT, "model")).toBe("whisper-1");
    expect(readMultipartField(FORM, CT, "MODEL")).toBe("whisper-1");
    expect(readMultipartField(FORM, CT, "language")).toBe("en");
    expect(readMultipartField(FORM, CT, "file")).toBeNull();
    expect(readMultipartField(FORM, CT, "prompt")).toBeNull();
    expect(readMultipartField(body(field("model", "first"), field("model", "second")), CT, "model")).toBe("first");
  });

  it("finds the boundary quoted, unquoted, or followed by another parameter, and gives up without one", () => {
    expect(readMultipartField(FORM, 'multipart/form-data; boundary="XYZ"', "model")).toBe("whisper-1");
    expect(readMultipartField(FORM, "multipart/form-data; BOUNDARY=XYZ ; charset=utf-8", "model")).toBe("whisper-1");
    for (const contentType of [undefined, "", "multipart/form-data", "multipart/form-data; boundary=OTHER"]) {
      expect(readMultipartField(FORM, contentType, "model")).toBeNull();
      expect(rewriteMultipartField(FORM, contentType, "model", "x")).toBeNull();
      expect(upsertMultipartField(FORM, contentType, "model", "x")).toBeNull();
    }
  });

  it("rewrites the first matching text field in place, or reports it absent", () => {
    expect(rewriteMultipartField(FORM, CT, "model", "upstream-model")?.toString("utf8")).toBe(body(file("file", "RIFF--XYZ-not-a-delimiter"), field("model", "upstream-model"), field("language", "en")).toString("utf8"));
    expect(rewriteMultipartField(FORM, CT, "prompt", "x")).toBeNull();
    expect(rewriteMultipartField(FORM, CT, "file", "x")).toBeNull();
    expect(rewriteMultipartField(body(field("model", "a"), field("model", "b")), CT, "model", "z")?.toString("utf8")).toBe(body(field("model", "z"), field("model", "b")).toString("utf8"));
  });

  it("upserts: replaces a present field, appends an absent one before the closing delimiter", () => {
    expect(upsertMultipartField(FORM, CT, "language", "fr")?.toString("utf8")).toBe(body(file("file", "RIFF--XYZ-not-a-delimiter"), field("model", " whisper-1 "), field("language", "fr")).toString("utf8"));
    expect(upsertMultipartField(FORM, CT, "prompt", "hi")?.toString("utf8")).toBe(body(file("file", "RIFF--XYZ-not-a-delimiter"), field("model", " whisper-1 "), field("language", "en"), field("prompt", "hi")).toString("utf8"));
    expect(upsertMultipartField(body(file("file", "has --XYZ-- inside")), CT, "p", "v")?.toString("utf8")).toBe(body(file("file", "has --XYZ-- inside"), field("p", "v")).toString("utf8"));
    expect(upsertMultipartField(Buffer.from("--XYZ\r\nno closing delimiter"), CT, "p", "v")).toBeNull();
  });
});
