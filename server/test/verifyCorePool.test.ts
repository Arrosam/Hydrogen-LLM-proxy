/**
 * Independent verification, CORE item C11, egress-proxy pool: when the proxy
 * host yields no address, the pool refuses -- it never answers the connection's
 * lookup with an empty list.
 *
 * Written from the verification spec only. The pool is driven the way
 * auditPool.test.ts drives it: the proxy-host resolver and undici's ProxyAgent
 * are replaced, and the lookup the pool hands the agent for the hop to the
 * proxy is read off the agent's options.
 *
 * The spec fixes the outcome (an error, never an empty answer) but not the
 * point at which the pool refuses, so each case accepts either: building the
 * dispatcher is refused, or the dispatcher is built and its lookup errors.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  agents: [] as Array<{ close: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; opts?: unknown }>,
}));
vi.mock("../src/core/upstream/egress/proxyHost", () => ({ resolveProxyHost: mocks.resolve }));
vi.mock("undici", () => ({
  ProxyAgent: class {
    close = vi.fn(async () => {});
    destroy = vi.fn(async () => {});
    opts: unknown;
    constructor(opts?: unknown) {
      this.opts = opts;
      mocks.agents.push(this);
    }
  },
}));

import { EgressProxyPool } from "../src/core/upstream/egress/pool";

type Cb = (err: Error | null, address: unknown, family?: number) => void;
type HopLookup = (hostname: string, options: { all?: boolean }, cb: Cb) => void;

interface Answer {
  err: Error | null;
  address: unknown;
  family: number | undefined;
}

const proxy = (id: number): { id: number; name: string; scheme: "http"; host: string; port: number; username: null; password: null } =>
  ({ id, name: `p${id}`, scheme: "http", host: `proxy${id}.example`, port: 8080, username: null, password: null });

const ask = (lookup: HopLookup, host: string, all: boolean): Promise<Answer> =>
  new Promise((resolve) => lookup(host, { all }, (err, address, family) => resolve({ err: err ?? null, address, family })));

/** The lookup the pool handed to agent `index` for the connection to the proxy. */
const hopLookup = (index: number): HopLookup => (mocks.agents[index].opts as { proxyTls: { lookup: HopLookup } }).proxyTls.lookup;

function expectRefused(got: Answer): void {
  expect(got.err).toBeInstanceOf(Error);
  expect(got.err === null && Array.isArray(got.address) && got.address.length === 0).toBe(false);
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.resolve.mockReset();
  mocks.agents.length = 0;
});

describe("C11: the egress-proxy pool refuses a proxy host that yields no address", () => {
  for (const all of [true, false]) {
    const form = all ? "all=true" : "single-address";

    it(`${form}: a first resolution with no address never becomes an empty lookup answer`, async () => {
      mocks.resolve.mockResolvedValue([]);
      const pool = new EgressProxyPool();
      let built = false;
      try {
        await pool.dispatcherFor(proxy(1));
        built = true;
      } catch (e) {
        // Refused outright: that is a refusal with an error.
        expect(e).toBeInstanceOf(Error);
      }
      if (built) {
        expect(mocks.agents).toHaveLength(1);
        expectRefused(await ask(hopLookup(0), "proxy1.example", all));
      }
      await pool.closeAll();
    });

    it(`${form}: a refresh that yields no address does not turn a good pin into an empty answer`, async () => {
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mocks.resolve.mockResolvedValue([{ address: "203.0.113.9", family: 4 }]);
      const pool = new EgressProxyPool();
      await pool.dispatcherFor(proxy(1));
      const lookup = hopLookup(0);
      // Sanity: the good pin answers.
      expect((await ask(lookup, "proxy1.example", all)).err).toBeNull();

      now += 30_000; // the pin is stale; the refresh finds nothing
      mocks.resolve.mockResolvedValue([]);
      let refreshed = false;
      try {
        await pool.dispatcherFor(proxy(1));
        refreshed = true;
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
      if (refreshed) {
        // Whatever dispatcher the pool now serves, its lookup must not answer
        // "success" with no address.
        for (let i = 0; i < mocks.agents.length; i++) {
          const got = await ask(hopLookup(i), "proxy1.example", all);
          expect(got.err === null && Array.isArray(got.address) && got.address.length === 0).toBe(false);
          expect(got.err === null && (got.address === undefined || got.address === "")).toBe(false);
        }
        expectRefused(await ask(hopLookup(mocks.agents.length - 1), "proxy1.example", all));
      }
      await pool.closeAll();
    });
  }

  it("a later good resolution recovers after an empty one", async () => {
    mocks.resolve.mockResolvedValueOnce([]);
    const pool = new EgressProxyPool();
    await pool.dispatcherFor(proxy(1)).catch(() => undefined);

    mocks.resolve.mockResolvedValue([{ address: "203.0.113.9", family: 4 }]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000); // past any pin window
    await pool.dispatcherFor(proxy(1));
    const got = await ask(hopLookup(mocks.agents.length - 1), "proxy1.example", false);
    expect(got).toEqual({ err: null, address: "203.0.113.9", family: 4 });
    await pool.closeAll();
  });

  // Neighbours that must be unchanged.
  it("unchanged: a resolved proxy host is answered with every pinned address (all=true)", async () => {
    const pinned = [{ address: "203.0.113.9", family: 4 }, { address: "2001:db8::9", family: 6 }];
    mocks.resolve.mockResolvedValue(pinned);
    const pool = new EgressProxyPool();
    await pool.dispatcherFor(proxy(1));
    expect(await ask(hopLookup(0), "proxy1.example", true)).toEqual({ err: null, address: pinned, family: undefined });
    await pool.closeAll();
  });

  it("unchanged: the single-address form gets the first pinned address", async () => {
    mocks.resolve.mockResolvedValue([{ address: "203.0.113.9", family: 4 }, { address: "2001:db8::9", family: 6 }]);
    const pool = new EgressProxyPool();
    await pool.dispatcherFor(proxy(1));
    expect(await ask(hopLookup(0), "proxy1.example", false)).toEqual({ err: null, address: "203.0.113.9", family: 4 });
    await pool.closeAll();
  });

  it("unchanged: a lookup for any host other than the proxy is an error", async () => {
    mocks.resolve.mockResolvedValue([{ address: "203.0.113.9", family: 4 }]);
    const pool = new EgressProxyPool();
    await pool.dispatcherFor(proxy(1));
    expect((await ask(hopLookup(0), "evil.example", true)).err).toBeInstanceOf(Error);
    await pool.closeAll();
  });
});
