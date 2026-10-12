/**
 * Independent verification, CORE item C11, direct client: a connection-time
 * DNS/pin lookup that yields no address is refused with an error, never
 * answered with an empty list.
 *
 * Written from the verification spec only. The client's connection-time lookup
 * is reached the way ssrfPin.test.ts reaches it (`lookupPinned`, the function
 * handed to the dispatcher's connect options), in both callback forms. DNS is
 * mocked; nothing here touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ default: { lookup: dns.lookup }, lookup: dns.lookup }));

import { UpstreamClient } from "../src/core/upstream/client";
import { SsrfGuard } from "../src/core/upstream/ssrf";

type LookupCb = (err: Error | null, address?: unknown, family?: number) => void;
type Lookup = (hostname: string, options: { all?: boolean }, cb: LookupCb) => void;

interface Answer {
  err: Error | null;
  address: unknown;
  family: number | undefined;
}

/** Ask the client's connection-time lookup for a host, as the HTTP client would. */
function ask(client: UpstreamClient, host: string, all: boolean): Promise<Answer> {
  return new Promise((resolve) => {
    (client as unknown as { lookupPinned: Lookup }).lookupPinned(host, { all }, (err, address, family) =>
      resolve({ err: err ?? null, address, family }));
  });
}

/** The property under test: no address means an error, in either callback form. */
function expectRefused(got: Answer): void {
  expect(got.err).toBeInstanceOf(Error);
  // Stated the other way round too: it is never "success, with nothing".
  expect(got.err === null && Array.isArray(got.address) && got.address.length === 0).toBe(false);
}

const HOST = "empty.example";

beforeEach(() => {
  dns.lookup.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("C11: the direct client's lookup refuses a host that yields no address", () => {
  for (const all of [true, false]) {
    const form = all ? "all=true" : "single-address";

    it(`${form}: the guard's validation returning no address is an error`, async () => {
      const guard = new SsrfGuard({ allowPrivate: true, allowlist: () => [] });
      vi.spyOn(guard, "validateHost").mockResolvedValue([]);
      const client = new UpstreamClient(guard);
      expectRefused(await ask(client, HOST, all));
    });

    it(`${form}: DNS answering with an empty list is an error`, async () => {
      dns.lookup.mockResolvedValue([]);
      const client = new UpstreamClient(new SsrfGuard({ allowPrivate: true, allowlist: () => [] }));
      expectRefused(await ask(client, HOST, all));
    });

    it(`${form}: an allowlisted host with an empty DNS answer is an error too`, async () => {
      dns.lookup.mockResolvedValue([]);
      const client = new UpstreamClient(new SsrfGuard({ allowPrivate: false, allowlist: () => [HOST] }));
      expectRefused(await ask(client, HOST, all));
    });

    it(`${form}: a pin taken from a resolution with no addresses is not answered from`, async () => {
      // The guard hands the transport a resolution that validated nothing.
      const guard = new SsrfGuard({ allowPrivate: true, allowlist: () => [] });
      vi.spyOn(guard, "resolveAllowed").mockResolvedValue({ host: HOST, addresses: [] });
      vi.spyOn(guard, "validateHost").mockResolvedValue([]);
      dns.lookup.mockResolvedValue([]);
      const client = new UpstreamClient(guard);

      // The request itself cannot succeed: there is nowhere to connect.
      await expect(client.getJson(`http://${HOST}:9/x`, {}, { timeoutMs: 2_000 })).rejects.toBeDefined();
      // And the lookup the connection would have used refuses, rather than
      // handing back the empty pin.
      expectRefused(await ask(client, HOST, all));
    });
  }

  it("the refusal is repeated on every ask, not cached into a later empty answer", async () => {
    const guard = new SsrfGuard({ allowPrivate: true, allowlist: () => [] });
    vi.spyOn(guard, "validateHost").mockResolvedValue([]);
    const client = new UpstreamClient(guard);
    expectRefused(await ask(client, HOST, true));
    expectRefused(await ask(client, HOST, true));
    expectRefused(await ask(client, HOST, false));
  });

  // Neighbours that must be unchanged.
  it("unchanged: a host that validates to addresses is answered with them (all=true)", async () => {
    const guard = new SsrfGuard({ allowPrivate: true, allowlist: () => [] });
    vi.spyOn(guard, "validateHost").mockResolvedValue([{ address: "203.0.113.7", family: 4 }, { address: "2001:db8::7", family: 6 }]);
    const client = new UpstreamClient(guard);
    const got = await ask(client, "ok.example", true);
    expect(got.err).toBeNull();
    expect(got.address).toEqual([{ address: "203.0.113.7", family: 4 }, { address: "2001:db8::7", family: 6 }]);
  });

  it("unchanged: the single-address form gets the first validated address and its family", async () => {
    const guard = new SsrfGuard({ allowPrivate: true, allowlist: () => [] });
    vi.spyOn(guard, "validateHost").mockResolvedValue([{ address: "203.0.113.7", family: 4 }, { address: "2001:db8::7", family: 6 }]);
    const client = new UpstreamClient(guard);
    const got = await ask(client, "ok.example", false);
    expect(got.err).toBeNull();
    expect(got.address).toBe("203.0.113.7");
    expect(got.family).toBe(4);
  });

  it("unchanged: a host that fails validation is an error (fail closed)", async () => {
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const client = new UpstreamClient(new SsrfGuard({ allowPrivate: false, allowlist: () => [] }));
    const got = await ask(client, "lan.example", true);
    expect(got.err).toBeInstanceOf(Error);
  });
});
