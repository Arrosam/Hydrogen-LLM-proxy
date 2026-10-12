import { afterEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({resolve:vi.fn(),agents:[] as Array<{close:ReturnType<typeof vi.fn>;destroy:ReturnType<typeof vi.fn>;opts?:unknown}>}));
vi.mock("../src/core/upstream/egress/proxyHost",()=>({resolveProxyHost:mocks.resolve}));
vi.mock("undici",()=>({ProxyAgent:class { close=vi.fn(()=>new Promise<void>(()=>{}));destroy=vi.fn(async()=>{});opts:unknown;constructor(opts?:unknown){this.opts=opts;mocks.agents.push(this);} }}));
import { EgressProxyPool } from "../src/core/upstream/egress/pool";
const proxy=(id:number)=>({id,name:`p${id}`,scheme:"http" as const,host:`proxy${id}.example`,port:8080,username:null,password:null});
const addresses=[{address:"8.8.8.8",family:4}];
afterEach(()=>{vi.restoreAllMocks();mocks.resolve.mockReset();mocks.agents.length=0;});
it("does not resurrect a dispatcher forgotten during DNS refresh",async()=>{
 let now=100;vi.spyOn(Date,"now").mockImplementation(()=>now);mocks.resolve.mockResolvedValue(addresses);
 const pool=new EgressProxyPool();const original=await pool.dispatcherFor(proxy(1));now+=31000;
 let resolved!:(v:typeof addresses)=>void;mocks.resolve.mockImplementationOnce(()=>new Promise(r=>{resolved=r;}));
 const waiting=pool.dispatcherFor(proxy(1));pool.forgetProxy(proxy(1));resolved(addresses);const fresh=await waiting;
 expect(fresh).not.toBe(original);expect(mocks.agents[0].destroy).toHaveBeenCalledOnce();await pool.closeAll();
});
it("LRU eviction drains active pools, while shutdown destroys both cached and retiring pools",async()=>{
 mocks.resolve.mockResolvedValue(addresses);const pool=new EgressProxyPool();
 for(let id=0;id<33;id++) await pool.dispatcherFor(proxy(id));
 expect(mocks.agents[0].close).toHaveBeenCalledOnce();expect(mocks.agents[0].destroy).not.toHaveBeenCalled();
 await pool.closeAll();expect(mocks.agents.every(a=>a.destroy.mock.calls.length===1)).toBe(true);
});

// ---------------------------------------------------------------------------
// Coverage additions: the cache-entry life cycle and the proxy-hop lookup.
// ---------------------------------------------------------------------------

describe("ST: a pooled dispatcher's life cycle", () => {
  it("eviction takes the least recently USED proxy, not the oldest created", async () => {
    mocks.resolve.mockResolvedValue(addresses);
    const pool = new EgressProxyPool();
    for (let id = 0; id < 32; id++) await pool.dispatcherFor(proxy(id));
    await pool.dispatcherFor(proxy(0)); // the oldest entry is used again
    await pool.dispatcherFor(proxy(32)); // one over the ceiling
    expect(mocks.agents[1].close).toHaveBeenCalledOnce(); // proxy(1) is now the coldest
    expect(mocks.agents[0].close).not.toHaveBeenCalled();
    expect(mocks.agents[32].close).not.toHaveBeenCalled();
    await pool.closeAll();
  });

  it("a full pool evicts nothing until one more proxy arrives", async () => {
    mocks.resolve.mockResolvedValue(addresses);
    const pool = new EgressProxyPool();
    for (let id = 0; id < 32; id++) await pool.dispatcherFor(proxy(id));
    expect(mocks.agents).toHaveLength(32);
    expect(mocks.agents.some((a) => a.close.mock.calls.length > 0)).toBe(false);
    await pool.closeAll();
  });

  it("a second use inside the pin window reuses the dispatcher without resolving again", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.resolve.mockResolvedValue(addresses);
    const pool = new EgressProxyPool();
    const first = await pool.dispatcherFor(proxy(1));
    now += 29_999; // last millisecond of the 30 s pin
    expect(await pool.dispatcherFor(proxy(1))).toBe(first);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.agents).toHaveLength(1);
    await pool.closeAll();
  });

  it("a stale pin is re-resolved in place: same dispatcher, no new agent", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.resolve.mockResolvedValue(addresses);
    const pool = new EgressProxyPool();
    const first = await pool.dispatcherFor(proxy(1));
    now += 30_000; // exactly the TTL: no longer fresh
    expect(await pool.dispatcherFor(proxy(1))).toBe(first);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.agents).toHaveLength(1);
    expect(mocks.agents[0].close).not.toHaveBeenCalled();
    expect(mocks.agents[0].destroy).not.toHaveBeenCalled();
    // The refresh restarts the window.
    now += 29_999;
    await pool.dispatcherFor(proxy(1));
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    await pool.closeAll();
  });

  it("two concurrent first uses of one proxy share a single dispatcher", async () => {
    mocks.resolve.mockResolvedValue(addresses);
    const pool = new EgressProxyPool();
    const [a, b] = await Promise.all([pool.dispatcherFor(proxy(1)), pool.dispatcherFor(proxy(1))]);
    expect(a).toBe(b);
    expect(mocks.agents).toHaveLength(1);
    await pool.closeAll();
  });

  it("a proxy host that fails validation builds nothing, and a later good resolution recovers", async () => {
    const refused = new Error("proxy p1 resolves to a disallowed address");
    mocks.resolve.mockRejectedValueOnce(refused);
    const pool = new EgressProxyPool();
    await expect(pool.dispatcherFor(proxy(1))).rejects.toBe(refused);
    expect(mocks.agents).toHaveLength(0);

    mocks.resolve.mockResolvedValue(addresses);
    const dispatcher = await pool.dispatcherFor(proxy(1));
    expect(mocks.agents).toHaveLength(1);
    expect(dispatcher).toBe(mocks.agents[0]);
    await pool.closeAll();
  });

  it("forgetting a proxy the pool never saw is a no-op", async () => {
    mocks.resolve.mockResolvedValue(addresses);
    const pool = new EgressProxyPool();
    await pool.dispatcherFor(proxy(1));
    expect(() => pool.forgetProxy(proxy(2))).not.toThrow();
    expect(mocks.agents[0].destroy).not.toHaveBeenCalled();
    await pool.closeAll();
  });

  it("forgetting a known proxy destroys its dispatcher, and the next use builds a new one", async () => {
    mocks.resolve.mockResolvedValue(addresses);
    const pool = new EgressProxyPool();
    const first = await pool.dispatcherFor(proxy(1));
    pool.forgetProxy(proxy(1));
    expect(mocks.agents[0].destroy).toHaveBeenCalledOnce();
    expect(await pool.dispatcherFor(proxy(1))).not.toBe(first);
    expect(mocks.agents).toHaveLength(2);
    await pool.closeAll();
  });

  it("changing only the password yields a different dispatcher; an identical config shares one", async () => {
    mocks.resolve.mockResolvedValue(addresses);
    const pool = new EgressProxyPool();
    const withAuth = (password: string) => ({ ...proxy(1), username: "u", password });
    const a = await pool.dispatcherFor(withAuth("old"));
    const b = await pool.dispatcherFor(withAuth("new"));
    const again = await pool.dispatcherFor({ ...withAuth("old"), id: 99, name: "same-proxy-other-row" });
    expect(b).not.toBe(a);
    expect(again).toBe(a);
    expect(mocks.agents).toHaveLength(2);
    await pool.closeAll();
  });
});

describe("DT: the proxy-hop lookup answers only for the proxy itself, from the pin", () => {
  type Cb = (err: Error | null, address: unknown, family?: number) => void;
  type HopLookup = (hostname: string, options: { all?: boolean }, cb: Cb) => void;

  /** The lookup the pool handed to the agent for the connection to the proxy. */
  async function hopLookup(p: ReturnType<typeof proxy>, pinned: Array<{ address: string; family: number }>): Promise<{ pool: EgressProxyPool; lookup: HopLookup }> {
    mocks.resolve.mockResolvedValue(pinned);
    const pool = new EgressProxyPool();
    await pool.dispatcherFor(p);
    const opts = mocks.agents[0].opts as { proxyTls: { lookup: HopLookup } };
    return { pool, lookup: opts.proxyTls.lookup };
  }
  const ask = (lookup: HopLookup, host: string, all: boolean): Promise<{ err: Error | null; address: unknown; family?: number }> =>
    new Promise((resolve) => lookup(host, { all }, (err, address, family) => resolve({ err, address, family })));

  const pinned = [{ address: "203.0.113.9", family: 4 }, { address: "2001:db8::9", family: 6 }];

  it("the proxy's own host gets every pinned address when all are asked for", async () => {
    const { pool, lookup } = await hopLookup(proxy(1), pinned);
    expect(await ask(lookup, "proxy1.example", true)).toEqual({ err: null, address: pinned, family: undefined });
    await pool.closeAll();
  });

  it("the single-address form gets the first pinned address and its family", async () => {
    const { pool, lookup } = await hopLookup(proxy(1), pinned);
    expect(await ask(lookup, "proxy1.example", false)).toEqual({ err: null, address: "203.0.113.9", family: 4 });
    await pool.closeAll();
  });

  it("the host comparison ignores case", async () => {
    const { pool, lookup } = await hopLookup(proxy(1), pinned);
    expect((await ask(lookup, "PROXY1.Example", false)).address).toBe("203.0.113.9");
    await pool.closeAll();
  });

  it("any other host is an error, never an OS lookup", async () => {
    const { pool, lookup } = await hopLookup(proxy(1), pinned);
    const got = await ask(lookup, "evil.example", true);
    expect(got.err).toBeInstanceOf(Error);
    expect(got.err!.message).toMatch(/"evil\.example", which is not proxy p1/);
    await pool.closeAll();
  });

  it("a bracketed IPv6 proxy host is matched without its brackets", async () => {
    const v6 = [{ address: "::1", family: 6 }];
    const { pool, lookup } = await hopLookup({ ...proxy(1), host: "[::1]" }, v6);
    expect(await ask(lookup, "::1", false)).toEqual({ err: null, address: "::1", family: 6 });
    await pool.closeAll();
  });

  it("a refreshed pin is what the existing dispatcher's lookup answers with", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { pool, lookup } = await hopLookup(proxy(1), pinned);
    now += 30_000;
    mocks.resolve.mockResolvedValue([{ address: "198.51.100.4", family: 4 }]);
    await pool.dispatcherFor(proxy(1));
    expect((await ask(lookup, "proxy1.example", false)).address).toBe("198.51.100.4");
    await pool.closeAll();
  });
});
