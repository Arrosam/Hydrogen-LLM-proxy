import dns from "node:dns/promises";
import net from "node:net";
import { getConfig } from "../context";

/**
 * Thrown when an upstream URL is rejected by the SSRF guard. Callers treat this
 * like any other transport error (the MUB engine wraps it into a failed
 * attempt; the provider-test route reports the message).
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
    ((Number(p[0]) << 24) >>> 0) +
    ((Number(p[1]) << 16) >>> 0) +
    ((Number(p[2]) << 8) >>> 0) +
    Number(p[3])
  );
}

function inV4Cidr(ipInt: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (v4ToInt(base) & mask);
}

function isBlockedV4(ip: string, allowPrivate: boolean): boolean {
  const n = v4ToInt(ip);
  // Always blocked, even when private upstreams are allowed: "this host",
  // link-local (includes 169.254.169.254 cloud metadata), and broadcast.
  if (inV4Cidr(n, "0.0.0.0", 8)) return true;
  if (inV4Cidr(n, "169.254.0.0", 16)) return true;
  if (inV4Cidr(n, "255.255.255.255", 32)) return true;
  if (allowPrivate) return false;
  // Gated: loopback, RFC1918 private, CGNAT, documentation/benchmark, reserved.
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

// --- IPv6 -------------------------------------------------------------------

function isBlockedV6(ip: string, allowPrivate: boolean): boolean {
  const a = ip.toLowerCase();
  // IPv4-mapped (::ffff:1.2.3.4) — evaluate the embedded v4 address.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a);
  if (mapped) return isBlockedV4(mapped[1], allowPrivate);
  if (a === "::") return true; // unspecified
  if (a.startsWith("fe80")) return true; // link-local — always blocked
  if (a === "::1") return !allowPrivate; // loopback
  if (a.startsWith("fc") || a.startsWith("fd")) return !allowPrivate; // ULA
  return false;
}

function isBlockedAddress(addr: string, allowPrivate: boolean): boolean {
  const v = net.isIP(addr);
  if (v === 4) return isBlockedV4(addr, allowPrivate);
  if (v === 6) return isBlockedV6(addr, allowPrivate);
  return true; // not a parseable IP → block
}

/**
 * Reject an upstream URL that uses a non-HTTP scheme or that resolves to a
 * private/loopback/link-local address. Prevents authenticated operators from
 * turning the proxy into an SSRF pivot into internal services or cloud
 * metadata. Set ALLOW_PRIVATE_UPSTREAMS=true to permit local upstreams.
 *
 * Note: this resolves DNS and checks the returned addresses. A hostname that
 * re-resolves to a private address after this check (DNS rebinding) is a
 * residual risk; operators fronting untrusted DNS should also restrict egress
 * at the network layer.
 */
export async function assertUpstreamAllowed(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UpstreamUrlError(`invalid upstream URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UpstreamUrlError(`unsupported upstream URL scheme "${url.protocol}" (use http/https)`);
  }

  const allowPrivate = getConfig().allowPrivateUpstreams;
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

  for (const addr of addrs) {
    if (isBlockedAddress(addr, allowPrivate)) {
      throw new UpstreamUrlError(
        `upstream host "${host}" resolves to a disallowed address (${addr}). ` +
          `Private, loopback, and link-local upstreams are blocked; ` +
          `set ALLOW_PRIVATE_UPSTREAMS=true to permit local upstreams.`,
      );
    }
  }
}
