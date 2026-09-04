import { Agent, request } from "undici";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { Readable } from "node:stream";
import type { SsrfGuard, ResolvedAddress } from "./ssrf";
import type { Transport, TransportJsonResult, TransportOptions, TransportStreamResult } from "./transport";

/**
 * How long a pinned resolution stays fresh. Pinning happens immediately
 * before each request, so the TTL only bounds how long a cached entry may be
 * reused by a pooled connection re-established on its own -- every request
 * re-pins, so an active stream's reconnects always re-validate first.
 */
const PIN_TTL_MS = 30_000;

/** Upper bound on remembered resolutions: the map is keyed by hostname, and
 * URLs arrive in request bodies (the file pre-pass), so a hostile client
 * could otherwise grow it without end. Insertion-order eviction is fine. */
const MAX_PINNED_HOSTS = 512;

/**
 * The concrete HTTP transport. Implements the {@link Transport} port used by
 * Request subclasses' send/relay, plus a getJson for provider connection tests.
 * Applies the SSRF guard before every request and the idle body timeout on
 * streams. Holds no global state -- the SsrfGuard is injected.
 *
 * DNS pinning: the guard validates a URL against one DNS resolution, and this
 * client pins the connection to exactly those validated addresses by
 * installing a custom `lookup` in its dispatcher's connect options (undici
 * spreads them into net/tls.connect). The HTTP client therefore never
 * re-resolves on its own -- the classic DNS-rebinding window (the guard sees
 * a public address, the connection binds a private one) stays closed. If the
 * lookup is ever asked for a host it holds no fresh pin for (a pooled socket
 * reconnecting after the pin expired), it re-validates through the guard
 * rather than trusting the OS resolver: fail-closed either way.
 */
export class UpstreamClient implements Transport {
  /**
   * All connections this client makes are established through this dispatcher
   * so every DNS resolution for an upstream goes through the pinned lookup.
   */
  private readonly dispatcher = new Agent({ connect: { lookup: this.lookupPinned.bind(this) } });
  /** hostname -> validated addresses + expiry, refreshed per request. */
  private readonly pinned = new Map<string, { addresses: ResolvedAddress[]; expiresAt: number }>();

  constructor(private readonly ssrf: SsrfGuard) {}

  /** Validate the URL and remember the addresses it was approved on. */
  private async pin(url: string): Promise<void> {
    const { host, addresses } = await this.ssrf.resolveAllowed(url);
    this.pinned.set(host, { addresses, expiresAt: Date.now() + PIN_TTL_MS });
    if (this.pinned.size > MAX_PINNED_HOSTS) {
      const oldest = this.pinned.keys().next().value;
      if (oldest != null) this.pinned.delete(oldest);
    }
  }

  /**
   * The custom DNS lookup every connection goes through. Answers with the
   * guard-validated addresses only: either the ones pinned by this request,
   * or a fresh validation when the pin is missing or expired.
   */
  private lookupPinned(
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void {
    const key = hostname.toLowerCase();
    // On the error paths the address argument is ignored (Node checks err
    // first), but the LookupFunction signature demands it be present.
    const fail = (err: unknown): void => {
      const e = err instanceof Error ? err : new Error(String(err));
      callback(e, "");
    };
    const respond = (addresses: ResolvedAddress[]): void => {
      if (options && options.all) {
        callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      } else if (addresses.length > 0) {
        callback(null, addresses[0].address, addresses[0].family);
      } else {
        fail(new Error(`no validated address for upstream host "${hostname}"`));
      }
    };

    const entry = this.pinned.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      respond(entry.addresses);
      return;
    }
    // Fail closed: never let the OS resolver answer for an unchecked host.
    void this.ssrf
      .validateHost(key)
      .then((addresses) => {
        this.pinned.set(key, { addresses, expiresAt: Date.now() + PIN_TTL_MS });
        respond(addresses);
      })
      .catch((err: unknown) => {
        fail(err);
      });
  }

  private combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!external) return timeout;
    const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
    return anyFn ? anyFn([timeout, external]) : timeout;
  }

  /** POST a JSON body and read the full JSON (or text) response. */
  async postJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    opts: TransportOptions,
  ): Promise<TransportJsonResult> {
    await this.pin(url);
    const res = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      dispatcher: this.dispatcher,
      signal: this.combineSignals(opts.timeoutMs, opts.signal),
      // undici defaults BOTH of these to 5 minutes when omitted. A non-streaming
      // upstream (a local model especially) sends its headers only after the
      // whole completion is computed, which can take far longer — the service's
      // timeoutMs must be the only cap, so pass it through explicitly.
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
    });
    const text = await res.body.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, headers: res.headers, json, text };
  }

  /**
   * POST a JSON body and return the raw response stream (for SSE translation).
   * `headersTimeout` bounds time-to-first-headers. `bodyTimeout` is an IDLE
   * timeout *between* body chunks -- undici resets it on every chunk (including
   * SSE keep-alive comments), so a long completion that keeps streaming is never
   * cut off, but a stream that goes silent aborts after `timeoutMs` instead of
   * hanging forever.
   */
  async postStream(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    opts: TransportOptions,
  ): Promise<TransportStreamResult> {
    await this.pin(url);
    const res = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      dispatcher: this.dispatcher,
      signal: opts.signal,
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
    });
    return { status: res.statusCode, headers: res.headers, body: res.body as unknown as Readable };
  }

  /** POST a pre-serialized body verbatim (e.g. a multipart form the caller
   * already framed — headers must carry the matching content-type). */
  async postRaw(
    url: string,
    headers: Record<string, string>,
    body: Buffer | string,
    opts: TransportOptions,
  ): Promise<TransportJsonResult> {
    await this.pin(url);
    const res = await request(url, {
      method: "POST",
      headers,
      body,
      dispatcher: this.dispatcher,
      signal: this.combineSignals(opts.timeoutMs, opts.signal),
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
    });
    const text = await res.body.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, headers: res.headers, json, text };
  }

  /** GET returning the raw response stream (binary downloads, e.g. video content). */
  async getStream(url: string, headers: Record<string, string>, opts: TransportOptions): Promise<TransportStreamResult> {
    await this.pin(url);
    const res = await request(url, {
      method: "GET",
      headers,
      dispatcher: this.dispatcher,
      signal: opts.signal,
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
    });
    return { status: res.statusCode, headers: res.headers, body: res.body as unknown as Readable };
  }

  /** GET request returning JSON (provider connection tests / model lists). */
  async getJson(url: string, headers: Record<string, string>, opts: TransportOptions): Promise<TransportJsonResult> {
    await this.pin(url);
    const res = await request(url, {
      method: "GET",
      headers,
      dispatcher: this.dispatcher,
      signal: this.combineSignals(opts.timeoutMs, opts.signal),
      // Same as postJson: keep undici's silent 5-minute defaults out of the way.
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
    });
    const text = await res.body.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, headers: res.headers, json, text };
  }
}