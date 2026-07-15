import dns from "node:dns/promises";
import net from "node:net";

/**
 * Thrown when an upstream URL is rejected by the SSRF guard. Callers treat this
 * like any other transport error (a failed attempt; the provider-test route
 * reports the message).
 */
export class UpstreamUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamUrlError";
  }
}

// --- IPv4 -------------------------------------------------------------------

function v4ToInt(ip: string): number {
  const p = ip.split(".");
  return (
    ((Number(p[0]) << 24) >>> 0) + ((Number(p[1]) << 16) >>> 0) + ((Number(p[2]) << 8) >>> 0) + Number(p[3])
  );
}

function inV4Cidr(ipInt: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (v4ToInt(base) & mask);
}

function v4IntBlocked(n: number, allowPrivate: boolean): boolean {
  // Always blocked, even when private upstreams are allowed: "this host",
  // link-local (includes 169.254.169.254 cloud metadata), and broadcast.
  if (inV4Cidr(n, "0.0.0.0", 8)) return true;
  if (inV4Cidr(n, "169.254.0.0", 16)) return true;
  if (inV4Cidr(n, "255.255.255.255", 32)) return true;
  if (allowPrivate) return false;
  return (
    inV4Cidr(n, "127.0.0.0", 8) ||
    inV4Cidr(n, "10.0.0.0", 8) ||
    inV4Cidr(n, "172.16.0.0", 12) ||
    inV4Cidr(n, "192.168.0.0", 16) ||
    inV4Cidr(n, "100.64.0.0", 10) ||
    inV4Cidr(n, "192.0.0.0", 24) ||
    inV4Cidr(n, "192.0.2.0", 24) ||
    inV4Cidr(n, "198.18.0.0", 15) ||
    inV4Cidr(n, "198.51.100.0", 24) ||
    inV4Cidr(n, "203.0.113.0", 24) ||
    inV4Cidr(n, "240.0.0.0", 4)
  );
}

function isBlockedV4(ip: string, allowPrivate: boolean): boolean {
  return v4IntBlocked(v4ToInt(ip), allowPrivate);
}

// --- IPv6 -------------------------------------------------------------------

function ipv6ToHextets(addr: string): number[] | null {
  const s = addr.split("%")[0]; // drop any zone id
  const halves = s.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (str: string): number[] | null => {
    if (str === "") return [];
    const groups = str.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.includes(".")) {
        if (i !== groups.length - 1 || net.isIP(g) !== 4) return null; // v4 only as the tail
        const n = v4ToInt(g);
        out.push((n >>> 16) & 0xffff, n & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };

  const head = parseGroups(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseGroups(halves[1]);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null; // "::" must stand for at least one zero group
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isBlockedV6(ip: string, allowPrivate: boolean): boolean {
  const h = ipv6ToHextets(ip);
  if (!h) return true; // unparseable -> block
  // v4-mapped / v4-compatible carry an IPv4 in the low 32 bits, whatever the
  // spelling; evaluate the embedded IPv4 against the v4 rules.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && (h[5] === 0xffff || h[5] === 0)) {
    return v4IntBlocked(((h[6] << 16) >>> 0) + h[7], allowPrivate);
  }
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local -- always blocked
  if ((h[0] & 0xfe00) === 0xfc00) return !allowPrivate; // fc00::/7 unique-local
  return false;
}

function isBlockedAddress(addr: string, allowPrivate: boolean): boolean {
  const v = net.isIP(addr);
  if (v === 4) return isBlockedV4(addr, allowPrivate);
  if (v === 6) return isBlockedV6(addr, allowPrivate);
  return true; // not a parseable IP -> block
}

// --- admin allowlist --------------------------------------------------------

function entryMatchesIp(entry: string, addrs: string[]): boolean {
  if (entry.includes("/")) {
    const [base, bitsStr] = entry.split("/");
    const bits = Number(bitsStr);
    if (net.isIP(base) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    return addrs.some((a) => net.isIP(a) === 4 && inV4Cidr(v4ToInt(a), base, bits));
  }
  const v = net.isIP(entry);
  if (v === 4) return addrs.some((a) => net.isIP(a) === 4 && v4ToInt(a) === v4ToInt(entry));
  if (v === 6) return addrs.some((a) => net.isIP(a) === 6 && a.toLowerCase() === entry);
  return false;
}

function hostAllowed(host: string, addrs: string[], allowlist: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith(".")) {
      if (h === entry.slice(1) || h.endsWith(entry)) return true;
    } else if (h === entry) {
      return true;
    }
    if (entryMatchesIp(entry, addrs)) return true;
  }
  return false;
}

export interface SsrfGuardConfig {
  /** Whether private/loopback/CGNAT upstreams are permitted (link-local stays blocked). */
  allowPrivate: boolean | (() => boolean);
  /** Admin-managed trusted-host allowlist, read fresh on each check. */
  allowlist: () => string[];
}

/**
 * Rejects an upstream URL that uses a non-HTTP scheme or resolves to a
 * private/loopback/link-local address, preventing the proxy from becoming an
 * SSRF pivot. An explicit admin allowlist entry overrides the block. Injected
 * (allowPrivate + a live allowlist getter) instead of reading globals.
 */
export class SsrfGuard {
  constructor(private readonly cfg: SsrfGuardConfig) {}

  /** Resolve the current allow-private flag (may be a live getter). */
  private allowPrivate(): boolean {
    const v = this.cfg.allowPrivate;
    return typeof v === "function" ? v() : v;
  }

  async assertAllowed(rawUrl: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new UpstreamUrlError(`invalid upstream URL: ${rawUrl}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new UpstreamUrlError(`unsupported upstream URL scheme "${url.protocol}" (use http/https)`);
    }

    let host = url.hostname;
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // IPv6 literal

    let addrs: string[];
    if (net.isIP(host)) {
      addrs = [host];
    } else {
      try {
        addrs = (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address);
      } catch {
        throw new UpstreamUrlError(`cannot resolve upstream host "${host}"`);
      }
      if (addrs.length === 0) throw new UpstreamUrlError(`upstream host "${host}" did not resolve`);
    }

    const allowlist = this.cfg.allowlist();
    if (allowlist.length && hostAllowed(host, addrs, allowlist)) return;

    for (const addr of addrs) {
      if (isBlockedAddress(addr, this.allowPrivate())) {
        throw new UpstreamUrlError(
          `upstream host "${host}" resolves to a disallowed address (${addr}). ` +
            `Private, loopback, and link-local upstreams are blocked; ` +
            `set ALLOW_PRIVATE_UPSTREAMS=true to permit local upstreams.`,
        );
      }
    }
  }
}
