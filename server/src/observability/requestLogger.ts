import type { Family } from "../core/format/family";
import { ZERO_USAGE, type Usage } from "../core/ir/usage";
import { serializeForLog } from "../util/logPayload";
import type { RequestLogRepo } from "../persistence/requestLogRepo";
import type { StatsCache } from "../persistence/statsCache";
import { redactHeaders } from "./redactor";

/** The client's HTTP request, captured verbatim (headers redacted) for the log. */
export interface HttpRequestInfo {
  method: string;
  path: string;
  query: string;
  headers: Record<string, unknown>;
  /**
   * The client body ALREADY serialized and size-bounded, not the parsed object.
   *
   * The log row is written when the request ends, which on a streaming call is
   * minutes after the body was read. Holding the object until then keeps the
   * whole parsed conversation live for the entire request; holding the bounded
   * string instead costs at most LOG_PAYLOAD_MAX_CHARS and lets the parse result
   * be collected as soon as the canonical request has been built from it.
   */
  bodyPayload: string;
}

export interface LogParams {
  traceId: string;
  tokenId: number | null;
  serviceId: number | null;
  requestedService: string | null;
  servedModel?: string | null;
  servedProvider?: string | null;
  ingress: Family;
  egress?: Family | null;
  streaming: boolean;
  httpStatus: number;
  http: HttpRequestInfo;
  /** The exact wire body sent upstream (after service overrides/translation),
   * so the effective temperature/thinking/etc. is visible — already serialized,
   * for the same reason as `http.bodyPayload`. Null when no upstream call was
   * made (auth/resolve errors) or for embeddings passthrough. */
  upstreamPayload?: string | null;
  responseHeaders?: Record<string, unknown> | null;
  responseBody?: unknown;
  usage?: Usage;
  latencyMs: number;
  attempts?: number;
  attemptPath?: unknown;
  error?: string | null;
}

/**
 * Writes one request_logs row per client request, capturing the entire HTTP-level
 * request (method, path, query, headers, body) with credential headers redacted,
 * plus the served model/provider as first-class columns.
 */
export class RequestLogger {
  constructor(
    private readonly repo: RequestLogRepo,
    private readonly maxChars: number | (() => number),
    /** Optional so tests can log without stats; the container always wires it. */
    private readonly stats?: StatsCache,
  ) {}

  /** Resolve the (possibly live) max-chars to a concrete number. */
  private limit(): number {
    const v = this.maxChars;
    return typeof v === "function" ? v() : v;
  }

  /**
   * Serialize a payload for the log NOW, at the current size limit, so the caller
   * can drop its reference to the object while the request is still running.
   * Capturing early is what keeps a long streaming call from pinning the whole
   * parsed conversation until its log row is written.
   */
  capture(value: unknown): string {
    return serializeForLog(value, this.limit());
  }

  /** Demote a logged 200 to 499 after late evidence that delivery failed. */
  amendDeliveryFailure(traceId: string, error: string): boolean {
    const changed = this.repo.markDeliveryFailed(traceId, error);
    // The row was folded into the stats as a success when it was written.
    if (changed) this.stats?.recordDeliveryFailure();
    return changed;
  }

  record(p: LogParams): void {
    const usage = p.usage ?? ZERO_USAGE;
    const maxChars = this.limit();
    const id = this.repo.insert({
      traceId: p.traceId,
      tokenId: p.tokenId,
      serviceId: p.serviceId,
      requestedService: p.requestedService,
      servedModel: p.servedModel ?? null,
      servedProvider: p.servedProvider ?? null,
      ingressFormat: p.ingress,
      egressFormat: p.egress ?? null,
      streaming: p.streaming,
      httpStatus: p.httpStatus,
      requestMethod: p.http.method,
      requestPath: p.http.path,
      requestQuery: p.http.query || null,
      requestHeaders: redactHeaders(p.http.headers),
      requestBody: p.http.bodyPayload,
      upstreamRequestBody: p.upstreamPayload ?? null,
      responseHeaders: p.responseHeaders ? redactHeaders(p.responseHeaders) : null,
      responseBody: p.responseBody != null ? serializeForLog(p.responseBody, maxChars) : null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      // The detail counters were parsed off every provider's response and then
      // thrown away here, so the cached share of a request -- the whole point of
      // running prompt caching -- was never visible anywhere.
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      latencyMs: p.latencyMs,
      attempts: p.attempts ?? 0,
      attemptPath: p.attemptPath ?? [],
      error: p.error ?? null,
    });
    this.stats?.recordRequest({
      id,
      httpStatus: p.httpStatus,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      latencyMs: p.latencyMs,
      requestedService: p.requestedService,
      servedModel: p.servedModel ?? null,
      servedProvider: p.servedProvider ?? null,
    });
  }
}
