import dns from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
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

/**
 * How long a pinned resolution stays fresh, on the direct path and for a
 * proxy's own host. Pinning happens immediately before each request, so the
 * TTL only bounds how long a cached entry may be reused by a pooled connection
 * re-established on its own -- every request re-pins, so an active stream's
 * reconnects always re-validate first.
 */
export const PIN_TTL_MS = 30_000;

/** `net.isIP` results. */
export const IP_V4 = 4;
export const IP_V6 = 6;

/** `URL.protocol` of the two schemes an upstream may use. */
export const URL_SCHEME_HTTP = "http:";
export const URL_SCHEME_HTTPS = "https:";

/**
 * Parse a URL an upstream request is about to be sent to, refusing anything
 * that is not http/https. The one definition of "a well-formed upstream URL",
 * shared by the direct path (the guard) and the proxied one (the transport).
 */
export function parseHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UpstreamUrlError(`invalid upstream URL: ${rawUrl}`);
  }
  if (url.protocol !== URL_SCHEME_HTTP && url.protocol !== URL_SCHEME_HTTPS) {
    throw new UpstreamUrlError(`unsupported upstream URL scheme "${url.protocol}" (use http/https)`);
  }
  return url;
}

/** The brackets around an IPv6 literal host. Only ever used with `replace`. */
const HOST_BRACKETS_RE = /^\[|\]$/g;

/** A host without the brackets an IPv6 literal is written in. */
export function stripHostBrackets(host: string): string {
  return host.replace(HOST_BRACKETS_RE, "");
}

// --- IPv4 -------------------------------------------------------------------

const V4_BITS = 32;
const V4_FULL_MASK = 0xffffffff;
const OCTET_BITS = 8;

interface V4Range {
  base: string;
  bits: number;
}

/**
 * Always blocked, even when private upstreams are allowed: "this host",
 * link-local (includes 169.254.169.254 cloud metadata), multicast (never a
 * unicast upstream), and broadcast.
 */
const V4_ALWAYS_BLOCKED: readonly V4Range[] = [
  { base: "0.0.0.0", bits: 8 }, // this host
  { base: "169.254.0.0", bits: 16 }, // link-local
  { base: "224.0.0.0", bits: 4 }, // multicast
  { base: "255.255.255.255", bits: 32 }, // broadcast
];
/** Blocked unless private upstreams are allowed. */
const V4_PRIVATE: readonly V4Range[] = [
  { base: "127.0.0.0", bits: 8 }, // loopback
  { base: "10.0.0.0", bits: 8 }, // RFC1918
  { base: "172.16.0.0", bits: 12 }, // RFC1918
  { base: "192.168.0.0", bits: 16 }, // RFC1918
  { base: "100.64.0.0", bits: 10 }, // CGNAT
  { base: "192.0.0.0", bits: 24 }, // IETF protocol assignments
  { base: "192.0.2.0", bits: 24 }, // TEST-NET-1
  { base: "198.18.0.0", bits: 15 }, // benchmarking
  { base: "198.51.100.0", bits: 24 }, // TEST-NET-2
  { base: "203.0.113.0", bits: 24 }, // TEST-NET-3
  { base: "240.0.0.0", bits: 4 }, // reserved
];

function v4ToInt(ip: string): number {
  const p = ip.split(".");
  return (
    ((Number(p[0]) << (3 * OCTET_BITS)) >>> 0) + ((Number(p[1]) << (2 * OCTET_BITS)) >>> 0) + ((Number(p[2]) << OCTET_BITS) >>> 0) + Number(p[3])
  );
}

function inV4Cidr(ipInt: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (V4_FULL_MASK << (V4_BITS - bits)) >>> 0;
  return (ipInt & mask) === (v4ToInt(base) & mask);
}

function inAnyV4Range(ipInt: number, ranges: readonly V4Range[]): boolean {
  return ranges.some((r) => inV4Cidr(ipInt, r.base, r.bits));
}

function v4IntBlocked(n: number, allowPrivate: boolean): boolean {
  if (inAnyV4Range(n, V4_ALWAYS_BLOCKED)) return true;
  return !allowPrivate && inAnyV4Range(n, V4_PRIVATE);
}

function isBlockedV4(ip: string, allowPrivate: boolean): boolean {
  return v4IntBlocked(v4ToInt(ip), allowPrivate);
}

// --- IPv6 -------------------------------------------------------------------

const V6_HEXTETS = 8;
const HEXTET_BITS = 16;
const HEXTET_MASK = 0xffff;
/** h[5] of a v4-mapped address (::ffff:a.b.c.d). */
const V6_V4_MAPPED_MARKER = 0xffff;
/** h[7] of the loopback address (::1). */
const V6_LOOPBACK_LAST_HEXTET = 1;
/**
 * fe80::/10 link-local, fec0::/10 site-local (deprecated, but still routed
 * inside a site only), fc00::/7 unique-local and ff00::/8 multicast, as a mask
 * and value on the first hextet.
 */
const V6_LINK_LOCAL = { mask: 0xffc0, value: 0xfe80 } as const;
const V6_SITE_LOCAL = { mask: 0xffc0, value: 0xfec0 } as const;
const V6_UNIQUE_LOCAL = { mask: 0xfe00, value: 0xfc00 } as const;
const V6_MULTICAST = { mask: 0xff00, value: 0xff00 } as const;
/** h[0], h[1] of the NAT64 well-known prefix 64:ff9b::/96 (the IPv4 is h[6..7]). */
const V6_NAT64_PREFIX = [0x64, 0xff9b] as const;
/** h[0] of 6to4, 2002::/16 (the IPv4 is h[1..2]). */
const V6_6TO4_PREFIX = 0x2002;

/** The IPv4 address two consecutive hextets carry. */
function hextetsToV4Int(high: number, low: number): number {
  return ((high << HEXTET_BITS) >>> 0) + low;
}

/** Whether every hextet in [from, to) is zero. */
function zeroHextets(h: readonly number[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (h[i] !== 0) return false;
  return true;
}

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
        if (i !== groups.length - 1 || net.isIP(g) !== IP_V4) return null; // v4 only as the tail
        const n = v4ToInt(g);
        out.push((n >>> HEXTET_BITS) & HEXTET_MASK, n & HEXTET_MASK);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };

  const head = parseGroups(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === V6_HEXTETS ? head : null;
  const tail = parseGroups(halves[1]);
  if (!tail) return null;
  const missing = V6_HEXTETS - head.length - tail.length;
  if (missing < 1) return null; // "::" must stand for at least one zero group
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isBlockedV6(ip: string, allowPrivate: boolean): boolean {
  const h = ipv6ToHextets(ip);
  if (!h) return true; // unparseable -> block
  if (zeroHextets(h, 0, 5)) {
    // ::1 is loopback and is treated as 127.0.0.0/8 is. It has to be named
    // before the v4-compatible rule below, which would read it as 0.0.0.1 --
    // inside the "this host" range that is refused whatever the flag says.
    if (h[5] === 0 && h[6] === 0 && h[7] === V6_LOOPBACK_LAST_HEXTET) return !allowPrivate;
    // v4-mapped / v4-compatible carry an IPv4 in the low 32 bits, whatever the
    // spelling; evaluate the embedded IPv4 against the v4 rules.
    if (h[5] === V6_V4_MAPPED_MARKER || h[5] === 0) return v4IntBlocked(hextetsToV4Int(h[6], h[7]), allowPrivate);
  }
  // NAT64 and 6to4 are translated or tunnelled to the IPv4 they embed, so
  // that address is the real target and is what gets judged.
  if (h[0] === V6_NAT64_PREFIX[0] && h[1] === V6_NAT64_PREFIX[1] && zeroHextets(h, 2, 6)) {
    return v4IntBlocked(hextetsToV4Int(h[6], h[7]), allowPrivate);
  }
  if (h[0] === V6_6TO4_PREFIX) return v4IntBlocked(hextetsToV4Int(h[1], h[2]), allowPrivate);
  if ((h[0] & V6_LINK_LOCAL.mask) === V6_LINK_LOCAL.value) return true; // fe80::/10 link-local -- always blocked
  if ((h[0] & V6_MULTICAST.mask) === V6_MULTICAST.value) return true; // ff00::/8 multicast -- always blocked
  if ((h[0] & V6_SITE_LOCAL.mask) === V6_SITE_LOCAL.value) return !allowPrivate; // fec0::/10 site-local
  if ((h[0] & V6_UNIQUE_LOCAL.mask) === V6_UNIQUE_LOCAL.value) return !allowPrivate; // fc00::/7 unique-local
  return false;
}

/**
 * Exported for the egress proxy-host guard (core/upstream/egress/proxyHost.ts),
 * which permits loopback and RFC1918 for an operator-configured proxy but must
 * keep the tier this refuses even when `allowPrivate` is true -- "this host",
 * link-local (cloud metadata), multicast and broadcast. Sharing the function is what stops
 * that tier from drifting between the two callers.
 */
export function isBlockedAddress(addr: string, allowPrivate: boolean): boolean {
  const v = net.isIP(addr);
  if (v === IP_V4) return isBlockedV4(addr, allowPrivate);
  if (v === IP_V6) return isBlockedV6(addr, allowPrivate);
  return true; // not a parseable IP -> block
}

// --- admin allowlist --------------------------------------------------------

const CIDR_SEPARATOR = "/";
/** A prefix length as written: plain decimal, no sign, spaces, exponent or leading zero. */
const CIDR_PREFIX_RE = /^(?:0|[1-9]\d?)$/;
/** A leading dot makes an entry stand for a domain and all of its subdomains. */
const DOMAIN_ENTRY_PREFIX = ".";
/** Dot-separated labels of letters, digits and inner hyphens. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** One admin allowlist entry, normalised (trimmed, lowercase). */
export type AllowlistEntry =
  | { kind: "cidr"; base: string; bits: number }
  | { kind: "ip"; family: typeof IP_V4 | typeof IP_V6; address: string }
  | { kind: "host"; name: string }
  | { kind: "domain"; name: string };

/**
 * Parse one allowlist entry: an IPv4 CIDR (`10.0.0.0/8`), an IP literal, a
 * hostname, or `.domain` for a domain and its subdomains. Returns null for
 * anything else.
 *
 * The one definition of a well-formed entry, shared by the guard (which
 * matches against it) and the admin route that stores the list (which refuses
 * what this returns null for). An entry overrides every address block, so a
 * malformed one must match nothing rather than be read generously: a prefix
 * length is taken only as plain decimal digits, never through `Number()`,
 * which reads an empty string as 0 and so used to turn `10.0.0.0/` into /0.
 */
export function parseAllowlistEntry(raw: string): AllowlistEntry | null {
  const entry = raw.trim().toLowerCase();
  if (!entry) return null;
  if (entry.includes(CIDR_SEPARATOR)) {
    const parts = entry.split(CIDR_SEPARATOR);
    if (parts.length !== 2) return null;
    const [base, bitsStr] = parts;
    if (net.isIP(base) !== IP_V4 || !CIDR_PREFIX_RE.test(bitsStr)) return null;
    const bits = Number(bitsStr);
    return bits <= V4_BITS ? { kind: "cidr", base, bits } : null;
  }
  const family = net.isIP(entry);
  if (family === IP_V4 || family === IP_V6) return { kind: "ip", family, address: entry };
  const isDomain = entry.startsWith(DOMAIN_ENTRY_PREFIX);
  const name = isDomain ? entry.slice(DOMAIN_ENTRY_PREFIX.length) : entry;
  if (!HOSTNAME_RE.test(name)) return null;
  return { kind: isDomain ? "domain" : "host", name };
}

function entryMatches(entry: AllowlistEntry, host: string, addrs: string[]): boolean {
  switch (entry.kind) {
    case "cidr":
      return addrs.some((a) => net.isIP(a) === IP_V4 && inV4Cidr(v4ToInt(a), entry.base, entry.bits));
    case "ip":
      if (host === entry.address) return true;
      if (entry.family === IP_V4) return addrs.some((a) => net.isIP(a) === IP_V4 && v4ToInt(a) === v4ToInt(entry.address));
      return addrs.some((a) => net.isIP(a) === IP_V6 && a.toLowerCase() === entry.address);
    case "host":
      return host === entry.name;
    case "domain":
      return host === entry.name || host.endsWith(DOMAIN_ENTRY_PREFIX + entry.name);
  }
}

function hostAllowed(host: string, addrs: string[], allowlist: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    const entry = parseAllowlistEntry(raw);
    if (entry && entryMatches(entry, h, addrs)) return true; // malformed -> matches nothing
  }
  return false;
}

export interface SsrfGuardConfig {
  /** Whether private/loopback/CGNAT upstreams are permitted (link-local stays blocked). */
  allowPrivate: boolean | (() => boolean);
  /** Admin-managed trusted-host allowlist, read fresh on each check. */
  allowlist: () => string[];
}

/** One validated address an upstream may be connected on. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Every address a host stands for: itself when it is already a literal IP,
 * otherwise all of its DNS answers in the resolver's own order. `errors` words
 * the two ways resolution fails, since an upstream and a proxy are reported to
 * the operator differently.
 */
export async function resolveHostAddresses(host: string, errors: { unresolvable: string; empty: string }): Promise<string[]> {
  if (net.isIP(host)) return [host];
  let addrs: string[];
  try {
    addrs = (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address);
  } catch {
    throw new UpstreamUrlError(errors.unresolvable);
  }
  if (addrs.length === 0) throw new UpstreamUrlError(errors.empty);
  return addrs;
}

/** Checked addresses in the shape a connection is pinned to. */
export function toResolvedAddresses(addrs: string[]): ResolvedAddress[] {
  return addrs.map((address) => ({ address, family: net.isIP(address) === IP_V6 ? IP_V6 : IP_V4 }));
}

/** The callback of a `net`/`tls` connect `lookup` function. */
export type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Answer a connect-time DNS lookup from validated addresses and nothing else:
 * every one of them when the caller asked for `all`, otherwise the first.
 *
 * With no address to give, the lookup fails with `noAddress`, whichever form
 * was asked for: an empty list is not an answer a connection can be pinned to,
 * so the direct path and the proxy pool both fail closed on it. On the error
 * path the address argument is ignored (Node checks err first), but the
 * LookupFunction signature demands it.
 */
export function answerLookup(
  addresses: ResolvedAddress[],
  options: LookupOptions | undefined,
  callback: LookupCallback,
  noAddress: () => Error,
): void {
  if (addresses.length === 0) {
    callback(noAddress(), "");
  } else if (options && options.all) {
    callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
  } else {
    callback(null, addresses[0].address, addresses[0].family);
  }
}

/** What {@link SsrfGuard.resolveAllowed} hands back to the transport. */
export interface UpstreamResolution {
  /** The URL's hostname: lowercase, IPv6 brackets stripped. */
  host: string;
  /** Every address the URL resolved to, all of which passed the checks. */
  addresses: ResolvedAddress[];
}

/**
 * Rejects an upstream URL that uses a non-HTTP scheme or resolves to a
 * private/loopback/link-local address, preventing the proxy from becoming an
 * SSRF pivot. An explicit admin allowlist entry overrides the block. Injected
 * (allowPrivate + a live allowlist getter) instead of reading globals.
 *
 * The checks also RETURN the validated addresses: the transport pins the
 * connection to exactly those (a custom DNS `lookup` in its connection
 * options), so the address that was checked is the address that is connected.
 * Without that, the HTTP client's own resolution would be a second lookup the
 * attacker controls -- the classic DNS-rebinding window this guard exists to
 * close.
 */
export class SsrfGuard {
  constructor(private readonly cfg: SsrfGuardConfig) {}

  /** Resolve the current allow-private flag (may be a live getter). */
  private allowPrivate(): boolean {
    const v = this.cfg.allowPrivate;
    return typeof v === "function" ? v() : v;
  }

  /** Assert-only variant, for callers that do not need the pinned addresses. */
  async assertAllowed(rawUrl: string): Promise<void> {
    await this.resolveAllowed(rawUrl);
  }

  /**
   * Validate a URL as {@link assertAllowed} does, and return the hostname plus
   * the addresses it is allowed to be connected on.
   */
  async resolveAllowed(rawUrl: string): Promise<UpstreamResolution> {
    const host = stripHostBrackets(parseHttpUrl(rawUrl).hostname.toLowerCase());
    const addresses = await this.validateHost(host);
    return { host, addresses };
  }

  /**
   * Resolve a bare hostname and run the same address checks on it. The
   * transport's fail-closed lookup path calls this when it is asked to connect
   * somewhere the per-request pin did not cover -- so even that path resolves
   * and validates, never falling back to the OS resolver unchecked.
   */
  async validateHost(host: string): Promise<ResolvedAddress[]> {
    const addrs = await resolveHostAddresses(host, {
      unresolvable: `cannot resolve upstream host "${host}"`,
      empty: `upstream host "${host}" did not resolve`,
    });

    const allowlist = this.cfg.allowlist();
    if (!(allowlist.length && hostAllowed(host, addrs, allowlist))) {
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

    return toResolvedAddresses(addrs);
  }
}
