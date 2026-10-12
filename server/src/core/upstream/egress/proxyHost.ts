import { isBlockedAddress, resolveHostAddresses, toResolvedAddresses, UpstreamUrlError, type ResolvedAddress } from "../ssrf";
import { MAX_PORT, MIN_PORT, proxyHostName, proxyLabel, type EgressProxy } from "./types";

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
 * cloud metadata lives), multicast, the broadcast address, and fe80::/10
 * -- in any IPv6 spelling that embeds one of them. Those are never
 * a proxy, and allowing them would turn this field into the metadata-endpoint
 * pivot the guard exists to prevent. That tier is reused from ssrf.ts verbatim
 * rather than restated, so the two cannot drift -- and so is the resolution
 * itself; only the wording of a failure is this file's own.
 */

/** Ports that are never a proxy and are dangerous to let an admin typo into. */
const REFUSED_PORTS = new Set([0, 22, 25, 465, 587]);

/**
 * Resolve and check a proxy's host, returning the addresses it may be
 * connected on. Those are pinned into the dispatcher exactly as
 * {@link SsrfGuard.resolveAllowed}'s are, so the proxy hop keeps the same
 * DNS-rebinding protection the direct path has.
 */
export async function resolveProxyHost(p: EgressProxy): Promise<ResolvedAddress[]> {
  if (!Number.isInteger(p.port) || p.port < MIN_PORT || p.port > MAX_PORT) {
    throw new UpstreamUrlError(`proxy ${proxyLabel(p)} has an invalid port`);
  }
  if (REFUSED_PORTS.has(p.port)) {
    throw new UpstreamUrlError(`proxy ${proxyLabel(p)} uses port ${p.port}, which is not a proxy port`);
  }

  const host = proxyHostName(p);
  if (!host) throw new UpstreamUrlError(`proxy "${p.name}" has no host`);

  const addrs = await resolveHostAddresses(host, {
    unresolvable: `cannot resolve proxy host "${host}" (proxy "${p.name}")`,
    empty: `proxy host "${host}" did not resolve`,
  });

  for (const addr of addrs) {
    // allowPrivate: true -- a proxy on 127.0.0.1, ::1 (what `localhost` often
    // resolves to first) or a LAN address is the normal case. The
    // always-refused tier still applies and is what this call keeps.
    if (isBlockedAddress(addr, true)) {
      throw new UpstreamUrlError(
        `proxy ${proxyLabel(p)} resolves to a disallowed address (${addr}). ` +
          `Loopback and private addresses are fine for a proxy; ` +
          `"this host", link-local (169.254.x.x, including cloud metadata), multicast and broadcast are not.`,
      );
    }
  }

  return toResolvedAddresses(addrs);
}
