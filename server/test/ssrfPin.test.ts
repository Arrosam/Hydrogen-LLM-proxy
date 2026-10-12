/**
 * DNS pinning between the SSRF guard and the HTTP client.
 *
 * The guard validates a URL against one DNS resolution; the transport pins the
 * connection to exactly those addresses via a custom `lookup` in its
 * dispatcher's connect options. These tests prove the mechanism (undici really
 * routes connection setup through that lookup) and the fail-closed fallback
 * (an unpinned host is re-validated, never resolved by the OS unchecked).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent, MockAgent, request } from "undici";
import { SsrfGuard, UpstreamUrlError, type ResolvedAddress } from "../src/core/upstream/ssrf";
import { UpstreamClient } from "../src/core/upstream/client";
import type { EgressProxyPool } from "../src/core/upstream/egress/pool";
import type { EgressProxy } from "../src/core/upstream/egress/types";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });
  // Dual-stack: the pinned lookup may answer with either loopback family.
  await new Promise<void>((resolve) => server.listen(0, "::", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A hostname that is guaranteed not to exist, so any successful connection
 * must have come through the supplied lookup, not the OS resolver. */
const GHOST_HOST = "hydrogen-pin-test.invalid";

describe("undici honours a custom connect lookup (the pinning mechanism)", () => {
  it("connects to the lookup's address for an unresolvable host", async () => {
    const { port } = server.address() as AddressInfo;
    const dispatcher = new Agent({
      connect: {
        lookup(hostname: string, options: LookupOptions, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void) {
          if (hostname !== GHOST_HOST) return callback(new Error(`unexpected host ${hostname}`), "");
          if (options && options.all) {
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
          } else {
            callback(null, "127.0.0.1", 4);
          }
        },
      },
    });
    try {
      const res = await request(`http://${GHOST_HOST}:${port}/ghost`, {
        method: "GET",
        dispatcher,
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      });
      const body = (await res.body.json()) as { path: string };
      expect(res.statusCode).toBe(200);
      expect(body.path).toBe("/ghost");
    } finally {
      await dispatcher.close();
    }
  });
});

describe("UpstreamClient pins guard-validated addresses", () => {
  // These guards run with allowPrivate off, so "localhost" (::1 or 127.0.0.1,
  // whichever the platform resolves first) is allowlisted explicitly: an
  // allowlist entry is a sanctioned override of every address block.
  const allowLocalhost = (): SsrfGuard => new SsrfGuard({ allowPrivate: false, allowlist: () => ["localhost"] });

  it("resolveAllowed returns the host plus the validated addresses", async () => {
    const resolution = await allowLocalhost().resolveAllowed(baseUrl);
    expect(resolution.host).toBe("localhost");
    expect(resolution.addresses.length).toBeGreaterThan(0);
    for (const a of resolution.addresses) expect(a.family === 4 || a.family === 6).toBe(true);
  });

  it("rejects a URL the guard blocks, before any connection is made", async () => {
    const guard = new SsrfGuard({ allowPrivate: false, allowlist: () => [] });
    const client = new UpstreamClient(guard);
    await expect(client.getJson(baseUrl, {}, { timeoutMs: 5_000 })).rejects.toThrow(/disallowed address/);
  });

  it("reaches an allowed upstream through the pinned dispatcher", async () => {
    const client = new UpstreamClient(allowLocalhost());
    const res = await client.getJson(`${baseUrl}/direct`, {}, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect((res.json as { path: string }).path).toBe("/direct");
  });

  it("the lookup answers in both callback forms (all=true and single)", async () => {
    const client = new UpstreamClient(allowLocalhost());
    // Prime the pin the same way a real request would.
    await client.getJson(`${baseUrl}/prime`, {}, { timeoutMs: 5_000 });

    const single = await new Promise<{ address?: string; family?: number }>((resolve, reject) => {
      (
        client as unknown as {
          lookupPinned: (h: string, o: { all?: boolean }, cb: (err: Error | null, address?: unknown, family?: number) => void) => void;
        }
      ).lookupPinned("localhost", { all: false }, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address: address as string, family });
      });
    });
    expect(typeof single.address).toBe("string");
    expect([4, 6]).toContain(single.family);

    const all = await new Promise<{ addresses: Array<{ address: string; family: number }> }>((resolve, reject) => {
      (
        client as unknown as {
          lookupPinned: (h: string, o: { all?: boolean }, cb: (err: Error | null, address?: unknown, family?: number) => void) => void;
        }
      ).lookupPinned("localhost", { all: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve({ addresses: addresses as Array<{ address: string; family: number }> });
      });
    });
    expect(all.addresses.length).toBeGreaterThan(0);
  });

  it("fail-closed fallback: an unpinned host is re-validated, not OS-resolved", async () => {
    const blocking = new SsrfGuard({ allowPrivate: false, allowlist: () => [] });
    const client = new UpstreamClient(blocking);
    // Nothing pinned: the lookup must go through validateHost, which rejects
    // the loopback host under this guard's policy.
    const err = await new Promise<Error | null>((resolve) => {
      (
        client as unknown as {
          lookupPinned: (h: string, o: { all?: boolean }, cb: (err: Error | null) => void) => void;
        }
      ).lookupPinned("localhost", { all: true }, (e) => resolve(e ?? null));
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/disallowed address/);
  });

  it("fail-closed fallback: an unresolvable host yields a lookup error", async () => {
    const guard = new SsrfGuard({ allowPrivate: true, allowlist: () => [] });
    const client = new UpstreamClient(guard);
    const err = await new Promise<Error | null>((resolve) => {
      (
        client as unknown as {
          lookupPinned: (h: string, o: { all?: boolean }, cb: (err: Error | null) => void) => void;
        }
      ).lookupPinned(GHOST_HOST, { all: true }, (e) => resolve(e ?? null));
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/cannot resolve/);
  });
});

// ---------------------------------------------------------------------------
// Coverage additions
// ---------------------------------------------------------------------------

type Lookup = (h: string, o: { all?: boolean }, cb: (err: Error | null, address?: unknown, family?: number) => void) => void;

/** Ask the client's connection-time lookup for a host, as undici would. */
function lookupAll(client: UpstreamClient, host: string): Promise<{ err: Error | null; addresses?: ResolvedAddress[] }> {
  return new Promise((resolve) => {
    (client as unknown as { lookupPinned: Lookup }).lookupPinned(host, { all: true }, (err, addresses) =>
      resolve({ err: err ?? null, addresses: addresses as ResolvedAddress[] | undefined }));
  });
}

describe("BVA: a pinned resolution is trusted for 30 seconds, then re-validated", () => {
  const T = 1_700_000_000_000;
  let now = T;

  afterEach(() => vi.restoreAllMocks());

  /** A client whose pin for `localhost` was taken at time T. */
  async function primedAt(allowlist: string[]): Promise<{ client: UpstreamClient; validateHost: ReturnType<typeof vi.spyOn> }> {
    now = T;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const guard = new SsrfGuard({ allowPrivate: false, allowlist: () => allowlist });
    const client = new UpstreamClient(guard);
    await client.getJson(`${baseUrl}/prime`, {}, { timeoutMs: 5_000 });
    // Spied only now: priming itself validates, and that call is not the subject.
    const validateHost = vi.spyOn(guard, "validateHost");
    return { client, validateHost };
  }

  it("one millisecond before expiry the pin answers and the guard is not consulted", async () => {
    const { client, validateHost } = await primedAt(["localhost"]);
    now = T + 29_999;
    const got = await lookupAll(client, "localhost");
    expect(got.err).toBeNull();
    expect(got.addresses!.length).toBeGreaterThan(0);
    expect(validateHost).not.toHaveBeenCalled();
  });

  it("at exactly 30 000 ms the pin is stale: the guard re-validates and its answer is used", async () => {
    const { client, validateHost } = await primedAt(["localhost"]);
    validateHost.mockResolvedValue([{ address: "203.0.113.7", family: 4 }]);
    now = T + 30_000;
    const got = await lookupAll(client, "localhost");
    expect(validateHost).toHaveBeenCalledTimes(1);
    expect(validateHost).toHaveBeenCalledWith("localhost");
    expect(got.err).toBeNull();
    expect(got.addresses).toEqual([{ address: "203.0.113.7", family: 4 }]);

    // The re-validation is itself pinned: the next lookup does not ask again.
    await lookupAll(client, "localhost");
    expect(validateHost).toHaveBeenCalledTimes(1);
  });

  it("a host the guard no longer allows fails the lookup once its pin has expired", async () => {
    const allowlist = ["localhost"];
    const { client } = await primedAt(allowlist);
    allowlist.length = 0; // the admin removed the entry while the pin was live

    now = T + 29_999;
    expect((await lookupAll(client, "localhost")).err).toBeNull(); // still the old pin

    now = T + 30_000;
    const got = await lookupAll(client, "localhost");
    expect(got.err).toBeInstanceOf(UpstreamUrlError);
    expect(got.err!.message).toMatch(/disallowed address/);
  });
});

describe("DT: which dispatcher a request uses, and what is validated for it", () => {
  const PROXY: EgressProxy = { id: 7, name: "corp", scheme: "http", host: "127.0.0.1", port: 7890, username: null, password: null };

  afterEach(() => vi.restoreAllMocks());

  function setup(dispatcher: unknown = {}): {
    client: UpstreamClient;
    resolveAllowed: ReturnType<typeof vi.spyOn>;
    dispatcherFor: ReturnType<typeof vi.fn>;
  } {
    const guard = new SsrfGuard({ allowPrivate: false, allowlist: () => [] });
    const resolveAllowed = vi.spyOn(guard, "resolveAllowed");
    const dispatcherFor = vi.fn(async () => dispatcher);
    const client = new UpstreamClient(guard, { dispatcherFor } as unknown as EgressProxyPool);
    return { client, resolveAllowed, dispatcherFor };
  }

  it("a proxied request on a client with no proxy pool is refused outright", async () => {
    const client = new UpstreamClient(new SsrfGuard({ allowPrivate: false, allowlist: () => [] }));
    const pending = client.getJson("http://8.8.8.8/x", {}, { timeoutMs: 1_000, proxy: PROXY });
    await expect(pending).rejects.toBeInstanceOf(UpstreamUrlError);
    await expect(pending).rejects.toThrow(/no proxy pool is available/);
  });

  it("a proxied request to an unparsable URL is refused before a dispatcher is built", async () => {
    const { client, dispatcherFor } = setup();
    const pending = client.postJson("not a url", {}, {}, { timeoutMs: 1_000, proxy: PROXY });
    await expect(pending).rejects.toBeInstanceOf(UpstreamUrlError);
    await expect(pending).rejects.toThrow(/invalid upstream URL: not a url/);
    expect(dispatcherFor).not.toHaveBeenCalled();
  });

  it("a proxied request to a non-http scheme is refused before a dispatcher is built", async () => {
    const { client, dispatcherFor } = setup();
    const pending = client.postStream("ftp://example.com/x", {}, {}, { timeoutMs: 1_000, proxy: PROXY });
    await expect(pending).rejects.toBeInstanceOf(UpstreamUrlError);
    await expect(pending).rejects.toThrow(/unsupported upstream URL scheme "ftp:"/);
    expect(dispatcherFor).not.toHaveBeenCalled();
  });

  it("a proxied request goes through the proxy's dispatcher, and the target address is not checked locally", async () => {
    // The target is a private literal the direct path would refuse: with a
    // proxy in the path it is the proxy that resolves and reaches it.
    const proxied = new MockAgent();
    proxied.disableNetConnect();
    proxied.get("http://10.0.0.5").intercept({ path: "/x", method: "GET" }).reply(200, { via: "proxy" });
    const { client, resolveAllowed, dispatcherFor } = setup(proxied);
    try {
      const res = await client.getJson("http://10.0.0.5/x", {}, { timeoutMs: 1_000, proxy: PROXY });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ via: "proxy" });
      expect(dispatcherFor).toHaveBeenCalledTimes(1);
      expect(dispatcherFor).toHaveBeenCalledWith(PROXY);
      expect(resolveAllowed).not.toHaveBeenCalled();
    } finally {
      await proxied.close();
    }
  });

  it("the same private target without a proxy is refused by the guard", async () => {
    const { client, resolveAllowed, dispatcherFor } = setup();
    await expect(client.getJson("http://10.0.0.5/x", {}, { timeoutMs: 1_000 })).rejects.toThrow(/disallowed address/);
    expect(resolveAllowed).toHaveBeenCalledTimes(1);
    expect(dispatcherFor).not.toHaveBeenCalled();
  });

  it("an unproxied request is validated by the guard and never touches the proxy pool", async () => {
    const guard = new SsrfGuard({ allowPrivate: false, allowlist: () => ["localhost"] });
    const resolveAllowed = vi.spyOn(guard, "resolveAllowed");
    const dispatcherFor = vi.fn();
    const client = new UpstreamClient(guard, { dispatcherFor } as unknown as EgressProxyPool);
    const res = await client.getJson(`${baseUrl}/direct`, {}, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(resolveAllowed).toHaveBeenCalledTimes(1);
    expect(resolveAllowed).toHaveBeenCalledWith(`${baseUrl}/direct`);
    expect(dispatcherFor).not.toHaveBeenCalled();
  });

  it("a proxy the pool refuses fails the request with the pool's error, not a direct connection", async () => {
    const guard = new SsrfGuard({ allowPrivate: false, allowlist: () => ["localhost"] });
    const dispatcherFor = vi.fn(async () => { throw new UpstreamUrlError("proxy corp has an invalid port"); });
    const client = new UpstreamClient(guard, { dispatcherFor } as unknown as EgressProxyPool);
    await expect(client.getJson(`${baseUrl}/direct`, {}, { timeoutMs: 5_000, proxy: PROXY })).rejects.toThrow("proxy corp has an invalid port");
  });
});
