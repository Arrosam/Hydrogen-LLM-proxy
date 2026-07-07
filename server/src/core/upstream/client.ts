import { request } from "undici";
import type { Readable } from "node:stream";
import type { SsrfGuard } from "./ssrf";
import type { Transport, TransportJsonResult, TransportOptions, TransportStreamResult } from "./transport";

/**
 * The concrete HTTP transport. Implements the {@link Transport} port used by
 * Request subclasses' send/relay, plus a getJson for provider connection tests.
 * Applies the SSRF guard before every request and the idle body timeout on
 * streams. Holds no global state -- the SsrfGuard is injected.
 */
export class UpstreamClient implements Transport {
  constructor(private readonly ssrf: SsrfGuard) {}

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
    await this.ssrf.assertAllowed(url);
    const res = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: this.combineSignals(opts.timeoutMs, opts.signal),
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
    await this.ssrf.assertAllowed(url);
    const res = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
    });
    return { status: res.statusCode, headers: res.headers, body: res.body as unknown as Readable };
  }

  /** GET request returning JSON (provider connection tests / model lists). */
  async getJson(url: string, headers: Record<string, string>, opts: TransportOptions): Promise<TransportJsonResult> {
    await this.ssrf.assertAllowed(url);
    const res = await request(url, {
      method: "GET",
      headers,
      signal: this.combineSignals(opts.timeoutMs, opts.signal),
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
