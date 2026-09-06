/**
 * DNS pinning between the SSRF guard and the HTTP client.
 *
 * The guard validates a URL against one DNS resolution; the transport pins the
 * connection to exactly those addresses via a custom `lookup` in its
 * dispatcher's connect options. These tests prove the mechanism (undici really
 * routes connection setup through that lookup) and the fail-closed fallback
 * (an unpinned host is re-validated, never resolved by the OS unchecked).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent, request } from "undici";
import { SsrfGuard } from "../src/core/upstream/ssrf";
import { UpstreamClient } from "../src/core/upstream/client";

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
  // "localhost" resolves to ::1 first on some platforms, and ::1 is blocked
  // even with allowPrivate (it parses as the v4-compat "this host" range), so
  // the tests allowlist it explicitly: an allowlist entry is a sanctioned
  // override of every address block.
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