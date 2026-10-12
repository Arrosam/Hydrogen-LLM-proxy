import { beforeEach, describe, expect, it, vi } from "vitest";

// DNS is scripted, never real: the hostname cases below must not depend on what
// the machine running the suite happens to resolve. IP literals never reach it.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ default: { lookup: dns.lookup }, lookup: dns.lookup }));

import { SsrfGuard, UpstreamUrlError } from "../src/core/upstream/ssrf";

const guard = (allowPrivate: boolean, allowlist: string[] = []) =>
  new SsrfGuard({ allowPrivate, allowlist: () => allowlist });

describe("SsrfGuard", () => {
  it("blocks loopback, private, and link-local IP literals by default", async () => {
    const g = guard(false);
    await expect(g.assertAllowed("http://127.0.0.1")).rejects.toThrow();
    await expect(g.assertAllowed("http://10.0.0.5")).rejects.toThrow();
    await expect(g.assertAllowed("http://192.168.1.1")).rejects.toThrow();
    await expect(g.assertAllowed("http://169.254.169.254")).rejects.toThrow(); // cloud metadata
  });

  it("allows public IP literals", async () => {
    await expect(guard(false).assertAllowed("http://8.8.8.8")).resolves.toBeUndefined();
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(guard(false).assertAllowed("file:///etc/passwd")).rejects.toThrow();
    await expect(guard(false).assertAllowed("gopher://x")).rejects.toThrow();
  });

  it("allowPrivate permits loopback/private but NOT link-local metadata", async () => {
    const g = guard(true);
    await expect(g.assertAllowed("http://127.0.0.1")).resolves.toBeUndefined();
    await expect(g.assertAllowed("http://10.0.0.5")).resolves.toBeUndefined();
    await expect(g.assertAllowed("http://169.254.169.254")).rejects.toThrow();
  });

  it("an explicit allowlist entry overrides the private block", async () => {
    const g = guard(false, ["10.0.0.5"]);
    await expect(g.assertAllowed("http://10.0.0.5")).resolves.toBeUndefined();
    await expect(g.assertAllowed("http://10.0.0.6")).rejects.toThrow();
  });

  it("blocks IPv4-mapped IPv6 loopback", async () => {
    await expect(guard(false).assertAllowed("http://[::ffff:127.0.0.1]")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Coverage additions: resolved hostnames, range boundaries, allowlist kinds.
// ---------------------------------------------------------------------------

/** Script the DNS answer per hostname; an unlisted host fails to resolve. */
function resolves(table: Record<string, string[] | Error>): void {
  dns.lookup.mockImplementation(async (host: string) => {
    const answer = table[host];
    if (answer === undefined) throw new Error(`ENOTFOUND ${host}`);
    if (answer instanceof Error) throw answer;
    return answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
}

beforeEach(() => {
  dns.lookup.mockReset();
  dns.lookup.mockRejectedValue(new Error("unexpected DNS lookup in an IP-literal test"));
});

describe("DT: the check runs on every address a hostname resolves to", () => {
  it("a host resolving only to a public address is allowed, and the addresses are returned", async () => {
    resolves({ "api.example": ["93.184.216.34"] });
    await expect(guard(false).resolveAllowed("http://api.example/v1")).resolves.toEqual({
      host: "api.example",
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
  });

  it("one private address among public ones rejects the whole host, naming the address", async () => {
    resolves({ "api.example": ["93.184.216.34", "10.0.0.5"] });
    const pending = guard(false).resolveAllowed("http://api.example/v1");
    await expect(pending).rejects.toBeInstanceOf(UpstreamUrlError);
    await expect(pending).rejects.toThrow("disallowed address (10.0.0.5)");
  });

  it("a link-local address among the answers rejects even with private upstreams allowed", async () => {
    resolves({ "api.example": ["93.184.216.34", "fe80::1"] });
    await expect(guard(true).resolveAllowed("http://api.example/")).rejects.toThrow("disallowed address (fe80::1)");
  });

  it("with private upstreams allowed, a host resolving to a private address passes", async () => {
    resolves({ "lan.example": ["10.0.0.5", "fd00::5"] });
    await expect(guard(true).resolveAllowed("http://lan.example/")).resolves.toEqual({
      host: "lan.example",
      addresses: [{ address: "10.0.0.5", family: 4 }, { address: "fd00::5", family: 6 }],
    });
  });

  it("a lookup failure is reported as an unresolvable upstream host", async () => {
    resolves({ "api.example": new Error("ENOTFOUND") });
    const pending = guard(false).resolveAllowed("http://api.example/");
    await expect(pending).rejects.toBeInstanceOf(UpstreamUrlError);
    await expect(pending).rejects.toThrow('cannot resolve upstream host "api.example"');
  });

  it("an empty answer is reported as a host that did not resolve", async () => {
    resolves({ "api.example": [] });
    await expect(guard(false).resolveAllowed("http://api.example/")).rejects.toThrow('upstream host "api.example" did not resolve');
  });

  it("scheme and host are case-insensitive; the returned host is lower-cased", async () => {
    resolves({ "api.example": ["93.184.216.34"] });
    const resolution = await guard(false).resolveAllowed("HTTP://API.Example/");
    expect(resolution.host).toBe("api.example");
    expect(dns.lookup).toHaveBeenCalledWith("api.example", expect.anything());
  });
});

type Verdict = "allowed" | "blocked";

async function verdict(g: SsrfGuard, url: string): Promise<Verdict> {
  try {
    await g.assertAllowed(url);
    return "allowed";
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamUrlError);
    expect((e as Error).message).toContain("disallowed address");
    return "blocked";
  }
}

describe("BVA: IPv4 block-list boundaries (private upstreams NOT allowed)", () => {
  const rows: Array<[string, Verdict]> = [
    // 10.0.0.0/8
    ["9.255.255.255", "allowed"], ["10.0.0.0", "blocked"], ["10.255.255.255", "blocked"], ["11.0.0.0", "allowed"],
    // 127.0.0.0/8
    ["126.255.255.255", "allowed"], ["127.0.0.0", "blocked"], ["127.255.255.255", "blocked"], ["128.0.0.0", "allowed"],
    // 172.16.0.0/12
    ["172.15.255.255", "allowed"], ["172.16.0.0", "blocked"], ["172.31.255.255", "blocked"], ["172.32.0.0", "allowed"],
    // 192.168.0.0/16
    ["192.167.255.255", "allowed"], ["192.168.0.0", "blocked"], ["192.168.255.255", "blocked"], ["192.169.0.0", "allowed"],
    // 100.64.0.0/10 (CGNAT)
    ["100.63.255.255", "allowed"], ["100.64.0.0", "blocked"], ["100.127.255.255", "blocked"], ["100.128.0.0", "allowed"],
    // 198.18.0.0/15 (benchmarking)
    ["198.17.255.255", "allowed"], ["198.18.0.0", "blocked"], ["198.19.255.255", "blocked"], ["198.20.0.0", "allowed"],
    // 192.0.0.0/24 and 192.0.2.0/24, with the unblocked /24 between them
    ["191.255.255.255", "allowed"], ["192.0.0.0", "blocked"], ["192.0.0.255", "blocked"], ["192.0.1.0", "allowed"],
    ["192.0.1.255", "allowed"], ["192.0.2.0", "blocked"], ["192.0.2.255", "blocked"], ["192.0.3.0", "allowed"],
    // 198.51.100.0/24
    ["198.51.99.255", "allowed"], ["198.51.100.0", "blocked"], ["198.51.100.255", "blocked"], ["198.51.101.0", "allowed"],
    // 203.0.113.0/24
    ["203.0.112.255", "allowed"], ["203.0.113.0", "blocked"], ["203.0.113.255", "blocked"], ["203.0.114.0", "allowed"],
    // 240.0.0.0/4 (its lower neighbour is multicast, blocked in its own right)
    ["239.255.255.255", "blocked"], ["240.0.0.0", "blocked"], ["255.255.255.254", "blocked"],
    // the tier that is blocked whatever the flag says
    ["0.0.0.0", "blocked"], ["0.255.255.255", "blocked"], ["1.0.0.0", "allowed"],
    ["169.253.255.255", "allowed"], ["169.254.0.0", "blocked"], ["169.254.255.255", "blocked"], ["169.255.0.0", "allowed"],
    ["255.255.255.255", "blocked"],
  ];
  it.each(rows)("%s is %s", async (ip, expected) => {
    expect(await verdict(guard(false), `http://${ip}/`)).toBe(expected);
  });
});

describe("BVA: IPv4 boundaries with private upstreams allowed", () => {
  const nowAllowed = [
    "10.0.0.0", "10.255.255.255", "127.0.0.0", "127.255.255.255", "172.16.0.0", "172.31.255.255",
    "192.168.0.0", "192.168.255.255", "100.64.0.0", "100.127.255.255", "198.18.0.0", "198.19.255.255",
    "192.0.0.255", "192.0.2.0", "198.51.100.0", "203.0.113.255", "240.0.0.0", "255.255.255.254",
  ];
  it.each(nowAllowed)("%s becomes allowed", async (ip) => {
    expect(await verdict(guard(true), `http://${ip}/`)).toBe("allowed");
  });

  const alwaysBlockedTier: Array<[string, Verdict]> = [
    ["0.0.0.0", "blocked"], ["0.255.255.255", "blocked"], ["1.0.0.0", "allowed"],
    ["169.253.255.255", "allowed"], ["169.254.0.0", "blocked"], ["169.254.255.255", "blocked"], ["169.255.0.0", "allowed"],
    ["255.255.255.255", "blocked"],
  ];
  it.each(alwaysBlockedTier)("%s is still %s", async (ip, expected) => {
    expect(await verdict(guard(true), `http://${ip}/`)).toBe(expected);
  });
});

describe("EP: IPv6 partitions", () => {
  // `::1`, site-local, NAT64, 6to4 and multicast are tabled in fixCoreSsrf.test.ts.
  const strict: Array<[string, Verdict]> = [
    ["fe80::1", "blocked"], ["febf::1", "blocked"], // fe80::/10 link-local, both ends
    ["fe7f::1", "allowed"], // just below fe80::/10
    ["fbff::1", "allowed"], ["fc00::1", "blocked"], ["fdff::1", "blocked"], ["fe00::1", "allowed"], // fc00::/7
    ["2001:4860:4860::8888", "allowed"], // ordinary global unicast
    ["::ffff:8.8.8.8", "allowed"], ["::ffff:10.0.0.1", "blocked"], // v4-mapped follows the v4 rules
    ["::ffff:7f00:1", "blocked"], // 127.0.0.1 spelled in hex
    ["::10.0.0.1", "blocked"], // v4-compatible
  ];
  it.each(strict)("private not allowed: [%s] is %s", async (addr, expected) => {
    expect(await verdict(guard(false), `http://[${addr}]/`)).toBe(expected);
  });

  const lenient: Array<[string, Verdict]> = [
    ["fc00::1", "allowed"], ["fd12::1", "allowed"], // unique-local opens up
    ["fe80::1", "blocked"], // link-local never does
    ["::ffff:10.0.0.1", "allowed"],
    ["::ffff:169.254.169.254", "blocked"], // metadata in an IPv6 spelling
  ];
  it.each(lenient)("private allowed: [%s] is %s", async (addr, expected) => {
    expect(await verdict(guard(true), `http://[${addr}]/`)).toBe(expected);
  });
});

describe("DT: allowlist entry kinds", () => {
  it("an IPv4 CIDR entry admits addresses inside it and nothing outside", async () => {
    const g = guard(false, ["10.0.0.0/8"]);
    expect(await verdict(g, "http://10.200.1.1/")).toBe("allowed");
    expect(await verdict(g, "http://10.255.255.255/")).toBe("allowed");
    expect(await verdict(g, "http://192.168.1.1/")).toBe("blocked");
  });

  it("a /32 entry admits exactly one address", async () => {
    const g = guard(false, ["10.0.0.5/32"]);
    expect(await verdict(g, "http://10.0.0.5/")).toBe("allowed");
    expect(await verdict(g, "http://10.0.0.4/")).toBe("blocked");
    expect(await verdict(g, "http://10.0.0.6/")).toBe("blocked");
  });

  it.each(["10.0.0.0/33", "10.0.0.0/x", "10.0.0.0/-1"])("a CIDR entry with an unusable prefix (%s) matches nothing", async (entry) => {
    expect(await verdict(guard(false, [entry]), "http://10.0.0.5/")).toBe("blocked");
  });

  it("CIDR entries are IPv4-only: an IPv6 prefix admits nothing", async () => {
    expect(await verdict(guard(false, ["fd00::/8"]), "http://[fd00::5]/")).toBe("blocked");
  });

  it("a leading-dot entry admits the domain and its subdomains, not a lookalike", async () => {
    resolves({ "corp.example": ["10.0.0.5"], "a.b.corp.example": ["10.0.0.5"], "evilcorp.example": ["10.0.0.5"] });
    const g = guard(false, [".corp.example"]);
    expect(await verdict(g, "http://corp.example/")).toBe("allowed");
    expect(await verdict(g, "http://a.b.corp.example/")).toBe("allowed");
    expect(await verdict(g, "http://evilcorp.example/")).toBe("blocked");
  });

  it("an exact hostname entry is trimmed and case-insensitive, and admits only that host", async () => {
    resolves({ "api.internal": ["10.0.0.5"], "other.internal": ["10.0.0.5"] });
    const g = guard(false, ["  API.Internal  "]);
    expect(await verdict(g, "http://api.internal/")).toBe("allowed");
    expect(await verdict(g, "http://other.internal/")).toBe("blocked");
  });

  it("an exact IPv6 entry admits that literal", async () => {
    const g = guard(false, ["fd00::5"]);
    expect(await verdict(g, "http://[fd00::5]/")).toBe("allowed");
    expect(await verdict(g, "http://[fd00::6]/")).toBe("blocked");
  });

  it("an IP entry also admits a hostname that resolves to it", async () => {
    resolves({ "db.example": ["10.0.0.5"] });
    expect(await verdict(guard(false, ["10.0.0.5"]), "http://db.example/")).toBe("allowed");
  });

  it("blank entries are skipped rather than matching everything", async () => {
    expect(await verdict(guard(false, ["", "   "]), "http://10.0.0.5/")).toBe("blocked");
  });

  it("an allowlisted host overrides even the always-blocked tier", async () => {
    resolves({ "metadata.internal": ["169.254.169.254"] });
    await expect(guard(false, ["metadata.internal"]).resolveAllowed("http://metadata.internal/")).resolves.toEqual({
      host: "metadata.internal",
      addresses: [{ address: "169.254.169.254", family: 4 }],
    });
  });

  it("the allowlist is read fresh on every check", async () => {
    const entries: string[] = [];
    const g = new SsrfGuard({ allowPrivate: false, allowlist: () => entries });
    expect(await verdict(g, "http://10.0.0.5/")).toBe("blocked");
    entries.push("10.0.0.5");
    expect(await verdict(g, "http://10.0.0.5/")).toBe("allowed");
  });

  it("allowPrivate may be a live getter", async () => {
    let allow = false;
    const g = new SsrfGuard({ allowPrivate: () => allow, allowlist: () => [] });
    expect(await verdict(g, "http://10.0.0.5/")).toBe("blocked");
    allow = true;
    expect(await verdict(g, "http://10.0.0.5/")).toBe("allowed");
  });
});

describe("EG: URL spellings that normalise to a blocked address", () => {
  it.each([
    "http://2130706433/", // decimal 127.0.0.1
    "http://0x7f.0.0.1/", // hex octet
    "http://127.1/", // short form
    "http://0177.0.0.1/", // octal octet
    "http://user:pw@127.0.0.1/", // userinfo is not the host
    "http://[::ffff:127.0.0.1]:8080/x", // v4-mapped, with port and path
  ])("%s is rejected", async (url) => {
    expect(await verdict(guard(false), url)).toBe("blocked");
  });

  it("an unparsable URL is rejected as invalid, before any lookup", async () => {
    const pending = guard(false).assertAllowed("not a url");
    await expect(pending).rejects.toBeInstanceOf(UpstreamUrlError);
    await expect(pending).rejects.toThrow("invalid upstream URL: not a url");
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("a non-http scheme is rejected by name, before any lookup", async () => {
    await expect(guard(true).assertAllowed("ftp://example.com/x")).rejects.toThrow('unsupported upstream URL scheme "ftp:"');
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("an upper-case scheme on a public literal is allowed", async () => {
    expect(await verdict(guard(false), "HTTPS://8.8.8.8")).toBe("allowed");
  });
});
