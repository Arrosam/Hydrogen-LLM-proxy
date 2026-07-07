import type { Family } from "../ir/params";
import type { Request, RequestData } from "../ir/request";
import type { Response } from "../ir/response";
import type { ResponseData, StreamContext, StreamEvent } from "../ir/stream";

/**
 * Runtime registry of the format subclasses. The base Request/Response classes
 * dispatch across families (e.g. a response parsed from the egress format is
 * rendered into the ingress format) without statically importing the subclasses,
 * which would form an import cycle. Each format module self-registers at load;
 * `core/format/index.ts` imports all three so the table is populated.
 */

export interface RequestClass {
  new (data: RequestData): Request;
  parse(body: Record<string, unknown>): Request;
}

export interface ResponseClass {
  new (data: ResponseData): Response;
  parse(body: Record<string, unknown>): Response;
  parseStream(readable: AsyncIterable<Buffer | string>): AsyncGenerator<StreamEvent>;
  serializeStream(events: AsyncGenerator<StreamEvent>, ctx: StreamContext): AsyncGenerator<string>;
}

const requestClasses: Partial<Record<Family, RequestClass>> = {};
const responseClasses: Partial<Record<Family, ResponseClass>> = {};

export function registerFormat(family: Family, classes: { request: RequestClass; response: ResponseClass }): void {
  requestClasses[family] = classes.request;
  responseClasses[family] = classes.response;
}

function requestClass(family: Family): RequestClass {
  const c = requestClasses[family];
  if (!c) throw new Error(`no request format registered for "${family}"`);
  return c;
}

function responseClass(family: Family): ResponseClass {
  const c = responseClasses[family];
  if (!c) throw new Error(`no response format registered for "${family}"`);
  return c;
}

/** Parse a client wire request into a canonical Request. */
export function parseRequest(family: Family, body: Record<string, unknown>): Request {
  return requestClass(family).parse(body);
}

/** Build an egress Request of `family` from canonical data (for sending upstream). */
export function buildRequest(family: Family, data: RequestData): Request {
  return new (requestClass(family))(data);
}

/** Parse an upstream wire response into a canonical Response. */
export function parseResponse(family: Family, body: Record<string, unknown>): Response {
  return responseClass(family).parse(body);
}

/** Build a Response of `family` from canonical data (for rendering to a client). */
export function buildResponse(family: Family, data: ResponseData): Response {
  return new (responseClass(family))(data);
}

/** Parse an upstream SSE stream (of `family`) into canonical events. */
export function parseStream(family: Family, readable: AsyncIterable<Buffer | string>): AsyncGenerator<StreamEvent> {
  return responseClass(family).parseStream(readable);
}

/** Serialize canonical events into a client SSE stream (of `family`). */
export function serializeStream(
  family: Family,
  events: AsyncGenerator<StreamEvent>,
  ctx: StreamContext,
): AsyncGenerator<string> {
  return responseClass(family).serializeStream(events, ctx);
}
