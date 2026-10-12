/**
 * Independent verification, CORE item C8 (upstream address guard) and the
 * guard half of C11 (a host that yields no address is refused).
 *
 * Written from the verification spec only. The guard is driven the way
 * ssrf.test.ts drives it: `new SsrfGuard({ allowPrivate, allowlist })`, with
 * DNS scripted so a hostname case never depends on the machine's resolver.
 *
 * Techniques: decision tables (address class x allow-private flag), boundary
 * values (the edges of 64:ff9b::/96, 2002::/16, fec0::/10, ff00::/8,
 * 224.0.0.0/4 and of an allowlisted CIDR), equivalence partitions (malformed
 * prefix spellings), each with neighbours that have to be unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ default: { lookup: dns.lookup }, lookup: dns.lookup }));

import { SsrfGuard, UpstreamUrlError, isBlockedAddress, parseAllowlistEntry } from "../src/core/upstream/ssrf";

const guard = (allowPrivate: boolean, allowlist: string[] = []): SsrfGuard =>
  new SsrfGuard({ allowPrivate, allowlist: () => allowlist });

/** Script the DNS answer per hostname; an unlisted host fails to resolve. */
function resolves(table: Record<string, string[]>): void {
  dns.lookup.mockImplementation(async (host: string) => {
    const answer = table[host];
    if (answer === undefined) throw new Error(`ENOTFOUND ${host}`);
    return answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
}

beforeEach(() => {
  dns.lookup.mockReset();
  dns.lookup.mockRejectedValue(new Error("unexpected DNS lookup in an IP-literal test"));
});

type Verdict = "allowed" | "blocked";

/** The guard's verdict on a URL. A block must be the guard's own refusal. */
async function verdict(g: SsrfGuard, url: string): Promise<Verdict> {
  try {
    await g.assertAllowed(url);
    return "allowed";
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamUrlError);
    return "blocked";
  }
}

const urlOf = (addr: string): string => (addr.includes(":") ? `http://[${addr}]/` : `http://${addr}/`);

/** The verdict on an address reached three ways: classifier, URL literal, DNS answer. */
async function verdicts(addr: string, allowPrivate: boolean): Promise<{ classifier: Verdict; literal: Verdict; resolved: Verdict }> {
  const classifier: Verdict = isBlockedAddress(addr, allowPrivate) ? "blocked" : "allowed";
  const literal = await verdict(guard(allowPrivate), urlOf(addr));
  resolves({ "target.example": [addr] });
  const resolved = await verdict(guard(allowPrivate), "http://target.example/");
  return { classifier, literal, resolved };
}

const all = (v: Verdict): { classifier: Verdict; literal: Verdict; resolved: Verdict } => ({ classifier: v, literal: v, resolved: v });

/** [address, verdict with private NOT allowed, verdict with private allowed] */
type Row = [string, Verdict, Verdict];

function table(name: string, rows: Row[]): void {
  describe(name, () => {
    for (const [addr, strict, lenient] of rows) {
      it(`${addr}: private not allowed -> ${strict}`, async () => {
        expect(await verdicts(addr, false)).toEqual(all(strict));
      });
      it(`${addr}: private allowed -> ${lenient}`, async () => {
        expect(await verdicts(addr, true)).toEqual(all(lenient));
      });
    }
  });
}

// ---------------------------------------------------------------------------
// C8(a) — ::1 and ::
// ---------------------------------------------------------------------------

table("C8(a): IPv6 loopback ::1 in every spelling is private; :: is always blocked", [
  ["::1", "blocked", "allowed"],
  ["0:0:0:0:0:0:0:1", "blocked", "allowed"],
  ["0000:0000:0000:0000:0000:0000:0000:0001", "blocked", "allowed"],
  ["::0001", "blocked", "allowed"],
  ["0::1", "blocked", "allowed"],
  ["0:0::0:1", "blocked", "allowed"],
  ["::", "blocked", "blocked"],
  ["0:0:0:0:0:0:0:0", "blocked", "blocked"],
  ["0000:0000:0000:0000:0000:0000:0000:0000", "blocked", "blocked"],
  ["0::0", "blocked", "blocked"],
]);

table("C8(a) neighbours: unchanged", [
  ["127.0.0.1", "blocked", "allowed"], // the IPv4 loopback keeps its rule
  ["0.0.0.0", "blocked", "blocked"], // the IPv4 unspecified address keeps its rule
  ["2001:4860:4860::8888", "allowed", "allowed"], // ordinary global unicast
  ["::ffff:127.0.0.1", "blocked", "allowed"], // v4-mapped loopback follows the v4 rule
]);

// ---------------------------------------------------------------------------
// C8(b) — NAT64, 6to4, site-local, multicast, link-local
// ---------------------------------------------------------------------------

table("C8(b): NAT64 64:ff9b::/96 is judged by its embedded IPv4", [
  ["64:ff9b::169.254.169.254", "blocked", "blocked"], // metadata
  ["64:ff9b::a9fe:a9fe", "blocked", "blocked"], // the same address, hex spelling
  ["64:ff9b:0:0:0:0:a9fe:a9fe", "blocked", "blocked"], // and fully expanded
  ["64:ff9b::10.0.0.1", "blocked", "allowed"], // private
  ["64:ff9b::a00:1", "blocked", "allowed"],
  ["64:ff9b::7f00:1", "blocked", "allowed"], // 127.0.0.1
  ["64:ff9b::c0a8:101", "blocked", "allowed"], // 192.168.1.1
  ["64:ff9b::8.8.8.8", "allowed", "allowed"], // public
  ["64:ff9b::808:808", "allowed", "allowed"],
  ["64:ff9b::0.0.0.0", "blocked", "blocked"], // "this host", always blocked
  ["64:ff9b::e000:1", "blocked", "blocked"], // 224.0.0.1 multicast, always blocked
]);

table("C8(b): 6to4 2002::/16 is judged by its embedded IPv4", [
  ["2002:a9fe:a9fe::", "blocked", "blocked"], // 169.254.169.254
  ["2002:a9fe:a9fe::1", "blocked", "blocked"],
  ["2002:a9fe:a9fe:1:2:3:4:5", "blocked", "blocked"],
  ["2002:a00:1::", "blocked", "allowed"], // 10.0.0.1
  ["2002:0a00:0001::1", "blocked", "allowed"],
  ["2002:7f00:1::", "blocked", "allowed"], // 127.0.0.1
  ["2002:c0a8:101::1", "blocked", "allowed"], // 192.168.1.1
  ["2002:808:808::", "allowed", "allowed"], // 8.8.8.8
  ["2002:0808:0808::1", "allowed", "allowed"],
]);

table("C8(b) neighbours: prefixes next to NAT64 and 6to4 are ordinary global unicast", [
  ["2001:a00:1::", "allowed", "allowed"], // just below 2002::/16, same embedded bits as 10.0.0.1
  ["2003:a00:1::", "allowed", "allowed"], // just above 2002::/16
  ["2003:a9fe:a9fe::", "allowed", "allowed"],
  ["64:ff9a::a00:1", "allowed", "allowed"], // just below 64:ff9b::
  ["64:ff9c::a9fe:a9fe", "allowed", "allowed"], // just above 64:ff9b::
]);

table("C8(b): fec0::/10 (site-local) is private", [
  ["fec0::", "blocked", "allowed"],
  ["fec0::1", "blocked", "allowed"],
  ["fed0::1", "blocked", "allowed"],
  ["feff::1", "blocked", "allowed"],
  ["feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "blocked", "allowed"],
]);

table("C8(b): link-local fe80::/10 and 169.254.0.0/16 stay blocked even with private allowed", [
  ["fe80::", "blocked", "blocked"],
  ["fe80::1", "blocked", "blocked"],
  ["febf::1", "blocked", "blocked"], // last address block of fe80::/10, right below fec0::
  ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "blocked", "blocked"],
  ["169.254.0.0", "blocked", "blocked"],
  ["169.254.169.254", "blocked", "blocked"],
  ["169.254.255.255", "blocked", "blocked"],
  ["::ffff:169.254.169.254", "blocked", "blocked"],
]);

table("C8(b): IPv6 multicast ff00::/8 is always blocked", [
  ["ff00::", "blocked", "blocked"],
  ["ff00::1", "blocked", "blocked"],
  ["ff02::1", "blocked", "blocked"],
  ["ff05::2", "blocked", "blocked"],
  ["ff0e::1", "blocked", "blocked"],
  ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "blocked", "blocked"],
]);

table("C8(b): IPv4 multicast 224.0.0.0/4 is always blocked", [
  ["224.0.0.0", "blocked", "blocked"],
  ["224.0.0.1", "blocked", "blocked"],
  ["230.1.2.3", "blocked", "blocked"],
  ["239.255.255.255", "blocked", "blocked"],
  ["::ffff:224.0.0.1", "blocked", "blocked"],
]);

table("C8(b) neighbours: the edges around the new ranges are unchanged", [
  ["223.255.255.255", "allowed", "allowed"], // just below 224.0.0.0/4
  ["240.0.0.0", "blocked", "allowed"], // just above it: reserved, private-tier as before
  ["fe7f::1", "allowed", "allowed"], // just below fe80::/10
  ["fc00::1", "blocked", "allowed"], // unique-local, private as before
  ["fdff::1", "blocked", "allowed"],
  ["fe00::1", "allowed", "allowed"], // between fc00::/7 and fe80::/10
  ["10.0.0.1", "blocked", "allowed"],
  ["8.8.8.8", "allowed", "allowed"],
]);

describe("C8(b): one bad address among a host's answers still rejects the whole host", () => {
  it("a public address plus a NAT64-wrapped metadata address is refused, private allowed or not", async () => {
    for (const allowPrivate of [false, true]) {
      resolves({ "api.example": ["93.184.216.34", "64:ff9b::a9fe:a9fe"] });
      expect(await verdict(guard(allowPrivate), "http://api.example/")).toBe("blocked");
    }
  });

  it("a public address plus a multicast address is refused, private allowed or not", async () => {
    for (const allowPrivate of [false, true]) {
      resolves({ "api.example": ["93.184.216.34", "ff02::1"] });
      expect(await verdict(guard(allowPrivate), "http://api.example/")).toBe("blocked");
    }
  });

  it("unchanged: a host with only public answers is allowed", async () => {
    resolves({ "api.example": ["93.184.216.34", "2001:4860:4860::8888"] });
    expect(await verdict(guard(false), "http://api.example/")).toBe("allowed");
  });
});

// ---------------------------------------------------------------------------
// C8(c) — admin allowlist entries
// ---------------------------------------------------------------------------

describe("C8(c): an allowlist entry with an empty or malformed prefix matches no address", () => {
  const MALFORMED = [
    "10.0.0.0/", // empty prefix
    "10.0.0.0/8/9", // two prefixes
    "10.0.0.0/ 8", // inner whitespace
    "10.0.0.0/0x8", // hex
    "10.0.0.0/33", // out of range
    "10.0.0.0/08", // leading zero
  ];
  // More members of the same partitions, by the same rule.
  const MALFORMED_SIBLINGS = ["0.0.0.0/", "10.0.0.0/+8", "10.0.0.0/8.0", "10.0.0.0/1e1", "10.0.0.0/-1", "10.0.0.0/x", "10.0.0.0/00"];

  /** Addresses a too-generous reading of the entry would let through. */
  const PROBES = ["169.254.169.254", "192.168.1.1", "10.0.0.0", "10.1.2.3", "127.0.0.1"];

  for (const entry of [...MALFORMED, ...MALFORMED_SIBLINGS]) {
    it(`parseAllowlistEntry(${JSON.stringify(entry)}) is null`, () => {
      expect(parseAllowlistEntry(entry)).toBeNull();
    });

    for (const probe of PROBES) {
      it(`${JSON.stringify(entry)} does not allow ${probe}`, async () => {
        expect(await verdict(guard(false, [entry]), `http://${probe}/`)).toBe("blocked");
      });
    }

    it(`${JSON.stringify(entry)} does not lift the always-blocked tier with private allowed either`, async () => {
      expect(await verdict(guard(true, [entry]), "http://169.254.169.254/")).toBe("blocked");
    });

    it(`${JSON.stringify(entry)} does not allow a host that resolves to a blocked address`, async () => {
      resolves({ "meta.example": ["169.254.169.254"], "lan.example": ["192.168.1.1"] });
      expect(await verdict(guard(false, [entry]), "http://meta.example/")).toBe("blocked");
      expect(await verdict(guard(false, [entry]), "http://lan.example/")).toBe("blocked");
    });
  }

  it("a malformed entry does not disturb a well-formed one beside it", async () => {
    const g = guard(false, ["10.0.0.0/", "192.168.1.1"]);
    expect(await verdict(g, "http://192.168.1.1/")).toBe("allowed");
    expect(await verdict(g, "http://192.168.1.2/")).toBe("blocked");
    expect(await verdict(g, "http://169.254.169.254/")).toBe("blocked");
  });
});

describe("C8(c): well-formed entries keep working", () => {
  it("parseAllowlistEntry accepts 10.0.0.0/8 as a /8", () => {
    expect(parseAllowlistEntry("10.0.0.0/8")).toEqual({ kind: "cidr", base: "10.0.0.0", bits: 8 });
  });

  it("10.0.0.0/8 allows 10.1.2.3 and the rest of the /8", async () => {
    const g = guard(false, ["10.0.0.0/8"]);
    expect(await verdict(g, "http://10.1.2.3/")).toBe("allowed");
    expect(await verdict(g, "http://10.0.0.0/")).toBe("allowed");
    expect(await verdict(g, "http://10.255.255.255/")).toBe("allowed");
  });

  it("10.0.0.0/8 allows nothing outside the /8", async () => {
    const g = guard(false, ["10.0.0.0/8"]);
    // 11.0.0.1 is public, so the guard's verdict cannot show the entry not
    // matching it; these blocked addresses outside the /8 can.
    expect(await verdict(g, "http://192.168.1.1/")).toBe("blocked");
    expect(await verdict(g, "http://172.16.0.1/")).toBe("blocked");
    expect(await verdict(g, "http://127.0.0.1/")).toBe("blocked");
    expect(await verdict(g, "http://169.254.169.254/")).toBe("blocked");
    // And 11.0.0.1 is no worse off for the entry being there.
    expect(await verdict(g, "http://11.0.0.1/")).toBe("allowed");
  });

  it("a prefix boundary inside blocked space is exact: 10.0.0.0/9", async () => {
    const g = guard(false, ["10.0.0.0/9"]);
    expect(await verdict(g, "http://10.127.255.255/")).toBe("allowed");
    expect(await verdict(g, "http://10.128.0.0/")).toBe("blocked");
  });

  it("11.0.0.0/8 does not allow 10.1.2.3 (an entry matches only its own range)", async () => {
    expect(await verdict(guard(false, ["11.0.0.0/8"]), "http://10.1.2.3/")).toBe("blocked");
  });

  it.each(["10.0.0.0/0", "10.0.0.0/1", "10.0.0.0/32", "0.0.0.0/0"])("%s is a valid entry", (entry) => {
    expect(parseAllowlistEntry(entry)).not.toBeNull();
    expect(parseAllowlistEntry(entry)).toMatchObject({ kind: "cidr" });
  });

  it("an explicit 0.0.0.0/0 is valid and matches every IPv4 address", async () => {
    expect(parseAllowlistEntry("0.0.0.0/0")).toEqual({ kind: "cidr", base: "0.0.0.0", bits: 0 });
    const g = guard(false, ["0.0.0.0/0"]);
    expect(await verdict(g, "http://10.1.2.3/")).toBe("allowed");
    expect(await verdict(g, "http://192.168.1.1/")).toBe("allowed");
    expect(await verdict(g, "http://169.254.169.254/")).toBe("allowed");
  });

  it("surrounding whitespace around a well-formed entry is still trimmed", async () => {
    expect(parseAllowlistEntry("  10.0.0.0/8  ")).toEqual({ kind: "cidr", base: "10.0.0.0", bits: 8 });
    expect(await verdict(guard(false, ["  10.0.0.0/8  "]), "http://10.1.2.3/")).toBe("allowed");
  });

  it("the other entry kinds parse as before", () => {
    expect(parseAllowlistEntry("10.0.0.5")).toMatchObject({ kind: "ip", address: "10.0.0.5" });
    expect(parseAllowlistEntry("API.Internal")).toEqual({ kind: "host", name: "api.internal" });
    expect(parseAllowlistEntry(".corp.example")).toMatchObject({ kind: "domain" });
    expect(parseAllowlistEntry("")).toBeNull();
    expect(parseAllowlistEntry("   ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C11 (guard half) — a host that yields no address is refused
// ---------------------------------------------------------------------------

describe("C11: a hostname whose lookup yields no address is refused by the guard", () => {
  for (const allowPrivate of [false, true]) {
    it(`resolveAllowed rejects instead of returning an empty address list (allowPrivate=${allowPrivate})`, async () => {
      resolves({ "empty.example": [] });
      const pending = guard(allowPrivate).resolveAllowed("http://empty.example/");
      await expect(pending).rejects.toBeInstanceOf(UpstreamUrlError);
    });

    it(`validateHost rejects instead of returning an empty address list (allowPrivate=${allowPrivate})`, async () => {
      resolves({ "empty.example": [] });
      await expect(guard(allowPrivate).validateHost("empty.example")).rejects.toBeInstanceOf(Error);
    });
  }

  it("an allowlisted host with no address is refused too", async () => {
    resolves({ "empty.example": [] });
    await expect(guard(false, ["empty.example"]).resolveAllowed("http://empty.example/")).rejects.toBeInstanceOf(UpstreamUrlError);
  });

  it("unchanged: a host with one public address resolves to exactly that address", async () => {
    resolves({ "api.example": ["93.184.216.34"] });
    await expect(guard(false).resolveAllowed("http://api.example/")).resolves.toEqual({
      host: "api.example",
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
  });
});
