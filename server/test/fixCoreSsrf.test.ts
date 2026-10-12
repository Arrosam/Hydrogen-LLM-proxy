import { beforeEach, describe, expect, it, vi } from "vitest";

// DNS is scripted, never real (see ssrf.test.ts). IP literals never reach it.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ default: { lookup: dns.lookup }, lookup: dns.lookup }));

import { resolveProxyHost } from "../src/core/upstream/egress/proxyHost";
import type { EgressProxy } from "../src/core/upstream/egress/types";
import { isBlockedAddress, parseAllowlistEntry, SsrfGuard } from "../src/core/upstream/ssrf";

type Verdict = "allowed" | "blocked";
const B: Verdict = "blocked";
const A: Verdict = "allowed";

const verdictOf = (addr: string, allowPrivate: boolean): Verdict => (isBlockedAddress(addr, allowPrivate) ? B : A);

const guard = (allowPrivate: boolean, allowlist: string[] = []): SsrfGuard => new SsrfGuard({ allowPrivate, allowlist: () => allowlist });

async function guardVerdict(g: SsrfGuard, url: string): Promise<Verdict> {
  try {
    await g.assertAllowed(url);
    return A;
  } catch {
    return B;
  }
}

function resolves(table: Record<string, string[]>): void {
  dns.lookup.mockImplementation(async (host: string) => {
    const addrs = table[host];
    if (!addrs) throw new Error(`ENOTFOUND ${host}`);
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
}

beforeEach(() => {
  dns.lookup.mockReset();
});

// --- C8(a)/(b): address classification ---------------------------------------
//
// One table, both tiers: [address, verdict without allowPrivate, verdict with].
// "blocked / blocked" is the tier nothing but an allowlist entry opens.

describe("C8: address classification table", () => {
  const rows: Array<[string, Verdict, Verdict, string]> = [
    // IPv6 loopback is loopback, exactly like 127.0.0.0/8
    ["::1", B, A, "IPv6 loopback"],
    ["0:0:0:0:0:0:0:1", B, A, "IPv6 loopback, expanded"],
    ["0000:0000:0000:0000:0000:0000:0000:0001", B, A, "IPv6 loopback, zero-padded"],
    ["127.0.0.1", B, A, "IPv4 loopback (unchanged reference row)"],
    // ...but its neighbours in ::/96 are still the v4-compatible "this host" range
    ["::", B, B, "unspecified"],
    ["::2", B, B, "v4-compatible 0.0.0.2"],
    ["::0.0.0.1", B, A, "IPv6 loopback, dotted tail"],
    // IPv4 multicast 224.0.0.0/4 -- never an upstream
    ["223.255.255.255", A, A, "just below multicast"],
    ["224.0.0.0", B, B, "multicast, first"],
    ["224.0.0.251", B, B, "mDNS"],
    ["239.255.255.255", B, B, "multicast, last"],
    ["::ffff:224.0.0.1", B, B, "v4-mapped multicast"],
    // IPv6 multicast ff00::/8
    ["feff::1", B, A, "just below ff00::/8: the top of site-local"],
    ["ff00::1", B, B, "multicast, first hextet low end"],
    ["ff02::1", B, B, "all-nodes"],
    ["ffff::1", B, B, "multicast, first hextet high end"],
    // site-local fec0::/10 (deprecated, still private)
    ["febf::1", B, B, "link-local top end (unchanged reference row)"],
    ["fec0::1", B, A, "site-local, first"],
    ["feff:ffff::1", B, A, "site-local, last"],
    ["fef0::1", B, A, "site-local, inside"],
    // NAT64 64:ff9b::/96 -- judged by the embedded IPv4
    ["64:ff9b::8.8.8.8", A, A, "NAT64 of a public address"],
    ["64:ff9b::808:808", A, A, "NAT64 of a public address, hex tail"],
    ["64:ff9b::10.0.0.1", B, A, "NAT64 of RFC1918"],
    ["64:ff9b::7f00:1", B, A, "NAT64 of 127.0.0.1"],
    ["64:ff9b::169.254.169.254", B, B, "NAT64 of cloud metadata"],
    ["64:ff9b::a9fe:a9fe", B, B, "NAT64 of cloud metadata, hex tail"],
    ["64:ff9b::224.0.0.1", B, B, "NAT64 of multicast"],
    ["64:ff9b:1::10.0.0.1", A, A, "outside the /96 (not the well-known prefix)"],
    // 6to4 2002::/16 -- the IPv4 is hextets 1-2
    ["2002:808:808::1", A, A, "6to4 of 8.8.8.8"],
    ["2002:a00:1::1", B, A, "6to4 of 10.0.0.1"],
    ["2002:7f00:1::", B, A, "6to4 of 127.0.0.1"],
    ["2002:c0a8:101:5::1", B, A, "6to4 of 192.168.1.1"],
    ["2002:a9fe:a9fe::1", B, B, "6to4 of cloud metadata"],
    ["2002:e000:1::1", B, B, "6to4 of multicast"],
    ["2002::1", B, B, "6to4 of 0.0.0.0"],
    ["2001:a00:1::1", A, A, "2001::/16 is not 6to4"],
    ["2003:a00:1::1", A, A, "2003::/16 is not 6to4"],
    // unchanged tiers, pinned here so the new branches cannot shadow them
    ["fe80::1", B, B, "link-local"],
    ["fc00::1", B, A, "unique-local"],
    ["::ffff:10.0.0.1", B, A, "v4-mapped RFC1918"],
    ["::ffff:169.254.169.254", B, B, "v4-mapped metadata"],
    ["2001:4860:4860::8888", A, A, "global unicast"],
    ["8.8.8.8", A, A, "public IPv4"],
    ["169.254.169.254", B, B, "metadata"],
    // unparseable -> blocked, whatever the flag says
    ["", B, B, "empty"],
    ["localhost", B, B, "a name, not an address"],
    ["::1::", B, B, "two compressions"],
    ["1.2.3", B, B, "short IPv4"],
    ["64:ff9b::10.0.0.1/96", B, B, "address with a prefix"],
  ];

  it.each(rows)("%s -> %s without allowPrivate, %s with (%s)", (addr, strict, lenient) => {
    expect(verdictOf(addr, false)).toBe(strict);
    expect(verdictOf(addr, true)).toBe(lenient);
  });
});

describe("C8: the guard applies the table to URLs and resolved names", () => {
  const urls: Array<[string, Verdict, Verdict]> = [
    ["http://[::1]:11434/", B, A],
    ["http://[64:ff9b::a00:1]/", B, A],
    ["http://[2002:a9fe:a9fe::1]/", B, B],
    ["http://[fec0::1]/", B, A],
    ["http://[ff02::1]/", B, B],
    ["http://224.0.0.1/", B, B],
  ];
  it.each(urls)("%s -> %s / %s", async (url, strict, lenient) => {
    expect(await guardVerdict(guard(false), url)).toBe(strict);
    expect(await guardVerdict(guard(true), url)).toBe(lenient);
  });

  it("localhost resolving to ::1 first is an allowed private upstream, and refused without the flag", async () => {
    resolves({ localhost: ["::1", "127.0.0.1"] });
    await expect(guard(true).resolveAllowed("http://localhost:11434/")).resolves.toEqual({
      host: "localhost",
      addresses: [
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    expect(await guardVerdict(guard(false), "http://localhost:11434/")).toBe(B);
  });

  it("one multicast answer still poisons an otherwise public name", async () => {
    resolves({ "api.example": ["93.184.216.34", "ff02::1"] });
    expect(await guardVerdict(guard(true), "http://api.example/")).toBe(B);
  });
});

describe("C8: the proxy-host guard keeps its never-even-with-allowPrivate tier", () => {
  const proxy = (host: string): EgressProxy => ({ id: 1, name: "px", scheme: "http", host, port: 7890, username: null, password: null });
  const rows: Array<[string, Verdict]> = [
    ["127.0.0.1", A],
    ["::1", A],
    ["[::1]", A],
    ["0:0:0:0:0:0:0:1", A],
    ["192.168.1.10", A],
    ["fec0::1", A],
    ["64:ff9b::10.0.0.1", A],
    ["0.0.0.0", B],
    ["::", B],
    ["169.254.169.254", B],
    ["::ffff:169.254.169.254", B],
    ["64:ff9b::169.254.169.254", B],
    ["2002:a9fe:a9fe::1", B],
    ["fe80::1", B],
    ["255.255.255.255", B],
    ["224.0.0.1", B],
    ["ff02::1", B],
  ];
  it.each(rows)("proxy host %s is %s", async (host, expected) => {
    let got: Verdict = A;
    try {
      await resolveProxyHost(proxy(host));
    } catch {
      got = B;
    }
    expect(got).toBe(expected);
  });

  it("a proxy named localhost is accepted when it resolves to ::1", async () => {
    resolves({ localhost: ["::1"] });
    await expect(resolveProxyHost(proxy("localhost"))).resolves.toEqual([{ address: "::1", family: 6 }]);
  });
});

// --- C8(c): allowlist entries -------------------------------------------------

describe("C8: parseAllowlistEntry -- well-formed entries", () => {
  const rows: Array<[string, unknown]> = [
    ["10.0.0.0/8", { kind: "cidr", base: "10.0.0.0", bits: 8 }],
    ["10.0.0.5/32", { kind: "cidr", base: "10.0.0.5", bits: 32 }],
    ["0.0.0.0/0", { kind: "cidr", base: "0.0.0.0", bits: 0 }],
    ["  192.168.0.0/16  ", { kind: "cidr", base: "192.168.0.0", bits: 16 }],
    ["10.0.0.5", { kind: "ip", family: 4, address: "10.0.0.5" }],
    ["FD00::5", { kind: "ip", family: 6, address: "fd00::5" }],
    ["::1", { kind: "ip", family: 6, address: "::1" }],
    ["API.Internal", { kind: "host", name: "api.internal" }],
    ["localhost", { kind: "host", name: "localhost" }],
    ["a-b.example.com", { kind: "host", name: "a-b.example.com" }],
    [".Corp.Example", { kind: "domain", name: "corp.example" }],
  ];
  it.each(rows)("%j", (raw, expected) => {
    expect(parseAllowlistEntry(raw)).toEqual(expected);
  });
});

describe("C8: parseAllowlistEntry -- malformed entries are null", () => {
  const rows: string[] = [
    "",
    "   ",
    // prefix length: empty, repeated, spaced, non-decimal, out of range
    "10.0.0.0/",
    "10.0.0.0/8/9",
    "10.0.0.0//8",
    "10.0.0.0/ 8",
    "10.0.0.0 /8",
    "10.0.0.0/0x8",
    "10.0.0.0/1e1",
    "10.0.0.0/8.0",
    "10.0.0.0/+8",
    "10.0.0.0/-1",
    "10.0.0.0/33",
    "10.0.0.0/008",
    "10.0.0.0/x",
    "/8",
    "/",
    // CIDR base must be an IPv4 literal
    "10.0.0/8",
    "10.0.0.256/8",
    "fd00::/8",
    "example.com/8",
    // not a host name
    "http://example.com",
    "example.com:8080",
    "exa mple.com",
    "-bad.example",
    "bad-.example",
    "a..b",
    ".",
    "..corp.example",
    "under_score.example",
    "*.example.com",
    "[::1]",
  ];
  it.each(rows)("%j", (raw) => {
    expect(parseAllowlistEntry(raw)).toBeNull();
  });
});

describe("C8: a malformed allowlist entry matches nothing", () => {
  // Each of these used to parse as /0 (or ignore the tail) and admit every
  // IPv4 target, the always-blocked tier included.
  const malformed = ["10.0.0.0/", "10.0.0.0/8/9", "10.0.0.0/ 8", "10.0.0.0/0x8", "10.0.0.0/1e1", "/", "/8", "0.0.0.0/"];
  const targets = ["http://10.0.0.5/", "http://169.254.169.254/", "http://127.0.0.1/", "http://192.168.1.1/"];

  it.each(malformed)("entry %j admits no blocked target", async (entry) => {
    for (const url of targets) expect(await guardVerdict(guard(false, [entry]), url)).toBe(B);
  });

  it.each(malformed)("entry %j does not disturb a public target or a valid sibling entry", async (entry) => {
    expect(await guardVerdict(guard(false, [entry]), "http://8.8.8.8/")).toBe(A);
    expect(await guardVerdict(guard(false, [entry, "10.0.0.0/8"]), "http://10.0.0.5/")).toBe(A);
    expect(await guardVerdict(guard(false, [entry, "10.0.0.0/8"]), "http://192.168.1.1/")).toBe(B);
  });

  it("a malformed host entry never matches the host it resembles", async () => {
    resolves({ "under_score.example": ["10.0.0.5"], "example.com": ["10.0.0.5"] });
    expect(await guardVerdict(guard(false, ["under_score.example"]), "http://under_score.example/")).toBe(B);
    expect(await guardVerdict(guard(false, ["example.com:8080"]), "http://example.com:8080/")).toBe(B);
  });

  it("well-formed entries behave as before", async () => {
    resolves({ "corp.example": ["10.0.0.5"], "a.corp.example": ["10.0.0.6"], "db.example": ["10.0.0.5"] });
    expect(await guardVerdict(guard(false, ["10.0.0.0/8"]), "http://10.200.1.1/")).toBe(A);
    expect(await guardVerdict(guard(false, ["10.0.0.0/8"]), "http://11.0.0.1/")).toBe(A); // public anyway
    expect(await guardVerdict(guard(false, ["10.0.0.0/8"]), "http://192.168.1.1/")).toBe(B);
    expect(await guardVerdict(guard(false, ["0.0.0.0/0"]), "http://169.254.169.254/")).toBe(A); // explicit, well-formed
    expect(await guardVerdict(guard(false, [".corp.example"]), "http://a.corp.example/")).toBe(A);
    expect(await guardVerdict(guard(false, ["Corp.Example"]), "http://corp.example/")).toBe(A);
    expect(await guardVerdict(guard(false, ["10.0.0.5"]), "http://db.example/")).toBe(A);
    expect(await guardVerdict(guard(false, ["FD00::5"]), "http://[fd00::5]/")).toBe(A);
    expect(await guardVerdict(guard(false, ["::1"]), "http://[::1]/")).toBe(A);
  });
});
