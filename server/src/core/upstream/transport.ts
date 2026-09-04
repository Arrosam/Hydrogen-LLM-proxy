import type { Readable } from "node:stream";
import type { EgressProxy } from "./egress/types";

/**
 * The HTTP transport a Request subclass uses to reach an upstream. The concrete
 * implementation (UpstreamClient, block 3) applies the SSRF guard and the idle
 * body timeout; this port keeps the format subclasses free of the network layer
 * so they can be unit-tested against a fake transport.
 */
export interface Transport {
  postJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    opts: TransportOptions,
  ): Promise<TransportJsonResult>;
  postStream(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    opts: TransportOptions,
  ): Promise<TransportStreamResult>;
  /** POST a pre-serialized body verbatim (multipart forms; the ASR pre-pass).
   * Optional so lightweight chat-only test stubs stay valid. */
  postRaw?(
    url: string,
    headers: Record<string, string>,
    body: Buffer | string,
    opts: TransportOptions,
  ): Promise<TransportJsonResult>;
  /** GET returning the raw response stream (binary downloads: video content, and
   * the file pre-pass that inlines a URL attachment). Optional for the same
   * reason as `postRaw`. The implementation runs the SSRF guard on the URL it is
   * given, so a caller following redirects must call it once per hop. */
  getStream?(
    url: string,
    headers: Record<string, string>,
    opts: TransportOptions,
  ): Promise<TransportStreamResult>;
}

export interface TransportOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Open this request's connection through a proxy instead of directly.
   *
   * Optional and absent by default, so a request that does not set it behaves
   * exactly as it did before proxies existed -- which is what every
   * client-supplied URL (the file pre-pass) relies on: nothing reachable from
   * a request body can select a proxy, so nothing client-supplied can opt out
   * of the direct path's DNS pinning.
   */
  proxy?: EgressProxy | null;
}

export interface TransportJsonResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: unknown;
  text: string;
}

export interface TransportStreamResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

/**
 * Everything a single send needs beyond the canonical request: the concrete
 * upstream target, resolved from the catalog for one attempt. `url` and
 * `headers` already carry the provider's auth; `providerMaxOutputTokens` lets
 * the thinking policy fit a budget under the provider's hard cap.
 */
export interface SendTarget {
  upstreamModel: string;
  url: string;
  headers: Record<string, string>;
  providerMaxOutputTokens?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** The provider's egress proxy, resolved with the rest of the target. */
  proxy?: EgressProxy | null;
}
