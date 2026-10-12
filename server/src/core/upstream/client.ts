import { Agent, request, type Dispatcher } from "undici";
import type { LookupOptions } from "node:dns";
import type { Readable } from "node:stream";
import type { SsrfGuard, ResolvedAddress, LookupCallback } from "./ssrf";
import type { Transport, TransportJsonResult, TransportOptions, TransportStreamResult } from "./transport";
import type { EgressProxyPool } from "./egress/pool";
import { answerLookup, parseHttpUrl, PIN_TTL_MS, UpstreamUrlError } from "./ssrf";
import { isSuccessStatus } from "../../util/httpStatus";

/** What a request carries: a value to serialize as JSON, bytes to send verbatim, or (a GET) nothing. */
type Payload = { json: unknown } | { raw: Buffer | string } | null;

/** The response of an undici `request`. */
type UpstreamReply = Dispatcher.ResponseData;

/** Upper bound on remembered resolutions: the map is keyed by hostname, and
 * URLs arrive in request bodies (the file pre-pass), so a hostile client
 * could otherwise grow it without end. Insertion-order eviction is fine. */
const MAX_PINNED_HOSTS = 512;

/** Name and message of the error a timed-out request is aborted with (those of `AbortSignal.timeout`). */
const TIMEOUT_ERROR_NAME = "TimeoutError";
const HEADERS_TIMEOUT_MESSAGE = "The operation was aborted due to timeout";

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

  constructor(
    private readonly ssrf: SsrfGuard,
    /**
     * Dispatchers for providers routed through an egress proxy. Omitted = no
     * proxying is possible and every request takes the direct, DNS-pinned
     * path, which is what the test fakes and any caller that predates proxies
     * gets for free.
     */
    private readonly egressPool?: EgressProxyPool,
  ) {}

  /**
   * Pick the dispatcher for one request, and do the address validation that
   * goes with it.
   *
   * DIRECT (the default, and every client-supplied URL): the target is
   * resolved, address-checked and pinned, and the shared DNS-pinned Agent is
   * used -- byte for byte what happened before proxies existed.
   *
   * PROXIED (only when a caller passed a provider's `opts.proxy`): the socket
   * goes to the proxy, so it is the PROXY host that is resolved, checked and
   * pinned; the target's address is resolved on the far side by the proxy and
   * cannot be pinned here. Pinning it locally would also defeat the purpose --
   * the usual reason to configure a proxy is that local resolution is the
   * thing that does not work. The target still has to be a well-formed
   * http/https URL, which is checked here rather than left to undici.
   */
  private async egress(url: string, opts: TransportOptions): Promise<Dispatcher> {
    if (!opts.proxy) {
      await this.pin(url);
      return this.dispatcher;
    }
    if (!this.egressPool) {
      throw new UpstreamUrlError("this provider is configured to use a proxy, but no proxy pool is available");
    }
    parseHttpUrl(url);
    return this.egressPool.dispatcherFor(opts.proxy);
  }

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
    callback: LookupCallback,
  ): void {
    const key = hostname.toLowerCase();
    const respond = (addresses: ResolvedAddress[]): void =>
      answerLookup(addresses, options, callback, () => new Error(`no validated address for upstream host "${hostname}"`));

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
        // The address argument is ignored on an error (Node checks err first),
        // but the LookupFunction signature demands it be present.
        callback(err instanceof Error ? err : new Error(String(err)), "");
      });
  }

  private combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!external) return timeout;
    return AbortSignal.any([timeout, external]);
  }

  /**
   * A signal that aborts at `timeoutMs` unless `disarm` is called first: the
   * deadline for a streamed reply's HEADERS, which must not outlive them and
   * cut the body. It aborts with the same TimeoutError `AbortSignal.timeout`
   * does, so a caller classifies both alike.
   */
  private headersDeadline(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; disarm(): void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(HEADERS_TIMEOUT_MESSAGE, TIMEOUT_ERROR_NAME)), timeoutMs);
    return {
      signal: external ? AbortSignal.any([controller.signal, external]) : controller.signal,
      disarm: () => clearTimeout(timer),
    };
  }

  /**
   * Send one request: pick the dispatcher (which validates the URL), then hand
   * it to undici.
   *
   * `headersTimeout` bounds time-to-first-headers and `bodyTimeout` is an IDLE
   * timeout between body chunks. undici defaults BOTH to 5 minutes when
   * omitted, and a non-streaming upstream (a local model especially) sends its
   * headers only after the whole completion is computed, which can take far
   * longer -- the service's timeoutMs must be the only cap, so it is passed
   * through explicitly on every request.
   *
   * `totalTimeout` additionally aborts the whole exchange, body included, at
   * timeoutMs. Every method wants that except {@link postStream}, which gets a
   * deadline on the headers alone: undici keeps `headersTimeout` on a coarse
   * shared timer (about a second), so on its own a sub-second timeoutMs was
   * not honoured before the first byte of a streamed reply.
   */
  private async dispatch(
    method: "GET" | "POST",
    url: string,
    headers: Record<string, string>,
    payload: Payload,
    opts: TransportOptions,
    totalTimeout: boolean,
  ): Promise<UpstreamReply> {
    const dispatcher = await this.egress(url, opts);
    const headersOnly = totalTimeout ? undefined : this.headersDeadline(opts.timeoutMs, opts.signal);
    try {
      return await request(url, {
        method,
        headers,
        ...(payload ? { body: "json" in payload ? JSON.stringify(payload.json) : payload.raw } : {}),
        dispatcher,
        signal: headersOnly ? headersOnly.signal : this.combineSignals(opts.timeoutMs, opts.signal),
        headersTimeout: opts.timeoutMs,
        bodyTimeout: opts.timeoutMs,
      });
    } finally {
      headersOnly?.disarm();
    }
  }

  /**
   * Read a whole reply as text, and as JSON when it parses. A body that does
   * not parse is `json: undefined` -- unless `strictJson`, where a 2xx that is
   * not JSON is an error rather than an answer.
   */
  private async readBuffered(res: UpstreamReply, strictJson: boolean): Promise<TransportJsonResult> {
    const text = await res.body.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      if (strictJson && isSuccessStatus(res.statusCode)) throw new Error("upstream returned invalid JSON");
      json = undefined;
    }
    return { status: res.statusCode, headers: res.headers, json, text };
  }

  private streamed(res: UpstreamReply): TransportStreamResult {
    return { status: res.statusCode, headers: res.headers, body: res.body as unknown as Readable };
  }

  /** POST a JSON body and read the full JSON (or text) response. */
  async postJson(url: string, headers: Record<string, string>, body: unknown, opts: TransportOptions): Promise<TransportJsonResult> {
    return this.readBuffered(await this.dispatch("POST", url, headers, { json: body }, opts, true), false);
  }

  /**
   * POST a JSON body and return the raw response stream (for SSE translation).
   * No total timeout: undici resets the idle `bodyTimeout` on every chunk
   * (including SSE keep-alive comments), so a long completion that keeps
   * streaming is never cut off, but a stream that goes silent aborts after
   * `timeoutMs` instead of hanging forever.
   */
  async postStream(url: string, headers: Record<string, string>, body: unknown, opts: TransportOptions): Promise<TransportStreamResult> {
    return this.streamed(await this.dispatch("POST", url, headers, { json: body }, opts, false));
  }

  /** POST a pre-serialized body verbatim (e.g. a multipart form the caller
   * already framed — headers must carry the matching content-type). */
  async postRaw(url: string, headers: Record<string, string>, body: Buffer | string, opts: TransportOptions): Promise<TransportJsonResult> {
    return this.readBuffered(await this.dispatch("POST", url, headers, { raw: body }, opts, true), false);
  }

  /** GET returning the raw response stream (binary downloads, e.g. video content). */
  async getStream(url: string, headers: Record<string, string>, opts: TransportOptions): Promise<TransportStreamResult> {
    return this.streamed(await this.dispatch("GET", url, headers, null, opts, true));
  }

  /** GET request returning JSON (provider connection tests / model lists). A 2xx that is not JSON throws. */
  async getJson(url: string, headers: Record<string, string>, opts: TransportOptions): Promise<TransportJsonResult> {
    return this.readBuffered(await this.dispatch("GET", url, headers, null, opts, true), true);
  }
}
