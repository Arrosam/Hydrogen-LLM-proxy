import dns from "node:dns/promises";
import net from "node:net";
import { isBlockedAddress, UpstreamUrlError, type ResolvedAddress } from "../ssrf";
import { proxyLabel, type EgressProxy } from "./types";

/**
 * Validating the host of a proxy, which is a different question from
 * validating an upstream URL.
 *
 * An upstream URL is attacker-adjacent: a provider's base URL is admin-set, but
 * a URL can also arrive inside a client's request body (the file pre-pass), so
 * SsrfGuard refuses private, loopback and link-local addresses by default. A
 * proxy host is not attacker-adjacent at all -- there is no code path by which
 * a client-supplied string becomes one. It comes from a row an admin created in
 * the Proxies tab, and nothing else writes that table.
 *
 * And the overwhelmingly common proxy IS on loopback: a local xray, clash,
 * mihomo or sing-box listening on 127.0.0.1:7890. Refusing that would refuse
 * the feature's main use case. So loopback and RFC1918 are permitted here.
 *
 * What is NOT permitted is the tier {@link isBlockedAddress} refuses even when
 * private addresses are allowed: 0.0.0.0/8, 169.254.0.0/16 (which is where
 * cloud metadata lives), the broadcast address, and fe80::/10. Those are never
 * a proxy, and allowing them would turn this field into the metadata-endpoint
 * pivot the guard exists to prevent. That tier is reused from ssrf.ts verbatim
 * rather than restated, so the two cannot drift.
 */

/** Spellings of IPv6 loopback. See the note at the check below for why these
 * need naming rather than falling out of the shared address classifier. */
const LOOPBACK_V6 = new Set(["::1", "0:0:0:0:0:0:0:1"]);

/** Ports that are never a proxy and are dangerous to let an admin typo into. */
const REFUSED_PORTS = new Set([0, 22, 25, 465, 587]);

/**
 * Resolve and check a proxy's host, returning the addresses it may be
 * connected on. Those are pinned into the dispatcher exactly as
 * {@link SsrfGuard.resolveAllowed}'s are, so the proxy hop keeps the same
 * DNS-rebinding protection the direct path has.
 */
export async function resolveProxyHost(p: EgressProxy): Promise<ResolvedAddress[]> {
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) {
    throw new UpstreamUrlError(`proxy ${proxyLabel(p)} has an invalid port`);
  }
  if (REFUSED_PORTS.has(p.port)) {
    throw new UpstreamUrlError(`proxy ${proxyLabel(p)} uses port ${p.port}, which is not a proxy port`);
  }

  const host = p.host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new UpstreamUrlError(`proxy "${p.name}" has no host`);

  let addrs: string[];
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address);
    } catch {
      throw new UpstreamUrlError(`cannot resolve proxy host "${host}" (proxy "${p.name}")`);
    }
    if (addrs.length === 0) throw new UpstreamUrlError(`proxy host "${host}" did not resolve`);
  }

  for (const addr of addrs) {
    // IPv6 loopback, which this validator exists to permit. The shared
    // classifier refuses it -- not as loopback, but because `::1` parses as a
    // v4-compatible address whose embedded IPv4 is 0.0.0.1, and 0.0.0.0/8 is
    // refused even when private addresses are allowed. Correct for an upstream;
    // wrong for a proxy, and it would otherwise refuse a proxy typed as
    // `localhost` on any machine that resolves it to ::1 before 127.0.0.1.
    if (LOOPBACK_V6.has(addr.toLowerCase())) continue;
    // allowPrivate: true -- a proxy on 127.0.0.1 or a LAN address is the normal
    // case. The always-refused tier still applies and is what this call keeps.
    if (isBlockedAddress(addr, true)) {
      throw new UpstreamUrlError(
        `proxy ${proxyLabel(p)} resolves to a disallowed address (${addr}). ` +
          `Loopback and private addresses are fine for a proxy; ` +
          `"this host", link-local (169.254.x.x, including cloud metadata) and broadcast are not.`,
      );
    }
  }

  return addrs.map((address) => ({ address, family: net.isIP(address) === 6 ? 6 : 4 }));
}
