import type { Family } from "../core/format/family";
import { ZERO_USAGE, type Usage } from "../core/ir/usage";
import { serializeForLog } from "../util/logPayload";
import type { RequestLogRepo } from "../persistence/requestLogRepo";
import { redactHeaders } from "./redactor";

/** The client's HTTP request, captured verbatim (headers redacted) for the log. */
export interface HttpRequestInfo {
  method: string;
  path: string;
  query: string;
  headers: Record<string, unknown>;
  body: unknown;
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
    private readonly maxChars: number,
  ) {}

  record(p: LogParams): void {
    const usage = p.usage ?? ZERO_USAGE;
    this.repo.insert({
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
      requestBody: serializeForLog(p.http.body, this.maxChars),
      responseHeaders: p.responseHeaders ? redactHeaders(p.responseHeaders) : null,
      responseBody: p.responseBody != null ? serializeForLog(p.responseBody, this.maxChars) : null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      latencyMs: p.latencyMs,
      attempts: p.attempts ?? 0,
      attemptPath: p.attemptPath ?? [],
      error: p.error ?? null,
    });
  }
}
