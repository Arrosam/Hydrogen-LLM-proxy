import { ProxyAgent, type Dispatcher } from "undici";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { ResolvedAddress } from "../ssrf";
import { resolveProxyHost } from "./proxyHost";
import { proxyKey, proxyLabel, proxyOrigin, type EgressProxy } from "./types";

/**
 * One `ProxyAgent` per distinct proxy configuration, cached.
 *
 * Two things here are easy to get wrong and are the reason this is a file
 * rather than three lines inside UpstreamClient.
 *
 * FIRST: which connect option covers the proxy hop. undici's ProxyAgent builds
 * the connector that reaches the PROXY from `opts.proxyTls`
 * (proxy-agent.js:131), and then REPLACES `opts.connect` with its own tunnel
 * function (proxy-agent.js:147-150). So a `connect: { lookup }` passed here --
 * the obvious thing to write, and what the direct dispatcher uses -- is
 * silently discarded, and the proxy's own hostname would be resolved by the OS
 * with no validation at all. The pin goes in `proxyTls`.
 *
 * SECOND: what is and is not validated once a proxy is in the path. The
 * connection is opened to the proxy, and the TARGET hostname is resolved by the
 * proxy, on the far side. No amount of local DNS work can pin that -- and
 * pinning it locally would defeat the point, because the usual reason to run a
 * proxy is that local resolution is the thing that does not work. So:
 *
 *   - the PROXY host is resolved and address-checked here, and pinned, exactly
 *     as a direct upstream is;
 *   - the TARGET url keeps its scheme/shape validation, but its address is the
 *     proxy's business.
 *
 * That is a real, deliberate narrowing of the guarantee, and it is confined to
 * providers an admin explicitly attached a proxy to. Every other request --
 * including every client-supplied URL, which is the only attacker-adjacent
 * input the transport ever sees -- keeps the full direct-path guarantee,
 * because nothing client-supplied can select a proxy.
 */

/** Ceiling on cached dispatchers. The map is kept in least-recently-USED
 * order (see the re-insert in dispatcherFor), so eviction takes the coldest. */
const MAX_DISPATCHERS = 32;

/** How long a proxy-host resolution stays pinned. Matches the direct path. */
const PIN_TTL_MS = 30_000;

interface Entry {
  dispatcher: Dispatcher;
  /** Addresses the proxy host validated to, and when they go stale. */
  addresses: ResolvedAddress[];
  expiresAt: number;
}

export class EgressProxyPool {
  private readonly entries = new Map<string, Entry>();

  /**
   * The dispatcher for this proxy, building and validating it on first use.
   *
   * Throws {@link UpstreamUrlError} when the proxy host is unresolvable or
   * disallowed, which the step runner classifies like any other failed attempt
   * -- so a bad proxy fails the request with a readable reason instead of
   * quietly falling back to a direct connection. Falling back would be worse
   * than failing: the operator attached a proxy because the direct route is not
   * acceptable, and silently taking it anyway leaks traffic they meant to route.
   */
  async dispatcherFor(proxy: EgressProxy): Promise<Dispatcher> {
    const key = proxyKey(proxy);
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      // Re-insert so Map order is least-recently-USED rather than
      // least-recently-created; otherwise eviction reaches for the pool
      // attached at boot to the busiest provider, which is the worst choice.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.dispatcher;
    }

    const addresses = await resolveProxyHost(proxy);

    if (existing) {
      // Same proxy, stale pin: refresh the addresses in place. The dispatcher
      // (and its pooled sockets) is still valid -- the lookup closure reads
      // this entry, so updating it is what re-points any reconnect.
      existing.addresses = addresses;
      existing.expiresAt = Date.now() + PIN_TTL_MS;
      return existing.dispatcher;
    }

    // `resolveProxyHost` awaited, so another request may have built this same
    // dispatcher while we were resolving. Without this check both would build
    // one and the loser's would be dropped from the map still holding sockets.
    const raced = this.entries.get(key);
    if (raced) {
      raced.addresses = addresses;
      raced.expiresAt = Date.now() + PIN_TTL_MS;
      return raced.dispatcher;
    }

    const entry: Entry = { dispatcher: undefined as unknown as Dispatcher, addresses, expiresAt: Date.now() + PIN_TTL_MS };
    entry.dispatcher = new ProxyAgent({
      uri: proxyOrigin(proxy),
      ...(proxy.username
        ? {
            token: `Basic ${Buffer.from(
              `${proxy.username}:${proxy.password ?? ""}`,
            ).toString("base64")}`,
          }
        : {}),
      // The pin, on the ONLY option that reaches the proxy hop. See the note
      // at the top of this file.
      proxyTls: { lookup: (hostname, options, callback) => this.lookupPinned(entry, proxy, hostname, options, callback) },
    });

    this.entries.set(key, entry);
    this.evictOldest();
    return entry.dispatcher;
  }

  /**
   * Resolve the proxy's hostname to the addresses it was validated on, and
   * nothing else. Fails closed: a host this entry holds no pin for is an
   * error, not an OS lookup.
   */
  private lookupPinned(
    entry: Entry,
    proxy: EgressProxy,
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void {
    const expected = proxy.host.trim().toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname.toLowerCase() !== expected) {
      callback(new Error(`proxy dispatcher asked to resolve "${hostname}", which is not proxy ${proxyLabel(proxy)}`), "");
      return;
    }
    const { addresses } = entry;
    if (addresses.length === 0) {
      callback(new Error(`no validated address for proxy ${proxyLabel(proxy)}`), "");
      return;
    }
    if (options && options.all) {
      callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  }

  private evictOldest(): void {
    while (this.entries.size > MAX_DISPATCHERS) {
      const oldest = this.entries.keys().next().value;
      if (oldest == null) return;
      const victim = this.entries.get(oldest);
      this.entries.delete(oldest);
      // Not awaited, and destroy() rather than close(): close() waits for
      // in-flight requests to drain, and this runs on a request path. The
      // victim is the least recently USED entry, so it is the least likely to
      // have anything in flight -- but this can still abort a long stream on an
      // installation with more than MAX_DISPATCHERS proxies in rotation.
      void victim?.dispatcher.destroy().catch(() => undefined);
    }
  }

  /**
   * Drop a proxy's dispatcher, given the proxy as it was BEFORE an edit.
   *
   * Not strictly required -- {@link proxyKey} includes every field that
   * changes behaviour, so an edited proxy simply builds a new dispatcher and
   * the stale one ages out through eviction. This closes it promptly instead,
   * so a corrected password does not leave a pool authenticating with the old
   * one until 32 other proxies push it out.
   */
  forgetProxy(proxy: EgressProxy): void {
    const entry = this.entries.get(proxyKey(proxy));
    if (!entry) return;
    this.entries.delete(proxyKey(proxy));
    void entry.dispatcher.destroy().catch(() => undefined);
  }

  /** Shut every pooled dispatcher down. Called once, on process shutdown. */
  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    // destroy(), not close(): shutdown must not block on a stream that is
    // still draining.
    await Promise.allSettled(all.map((e) => e.dispatcher.destroy()));
  }
}
