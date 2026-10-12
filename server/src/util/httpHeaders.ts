/** Header names (lower-case, as Node and undici present them) used in more than one module. */
export const HEADER = {
  ACCEPT: "accept",
  ANTHROPIC_BETA: "anthropic-beta",
  ANTHROPIC_VERSION: "anthropic-version",
  AUTHORIZATION: "authorization",
  CACHE_CONTROL: "cache-control",
  CONNECTION: "connection",
  CONTENT_LENGTH: "content-length",
  CONTENT_TYPE: "content-type",
  COOKIE: "cookie",
  HOST: "host",
  HTTP_REFERER: "http-referer",
  LOCATION: "location",
  OPENAI_BETA: "openai-beta",
  PROXY_AUTHORIZATION: "proxy-authorization",
  SET_COOKIE: "set-cookie",
  TRANSFER_ENCODING: "transfer-encoding",
  USER_AGENT: "user-agent",
  X_ACCEL_BUFFERING: "x-accel-buffering",
  X_API_KEY: "x-api-key",
  X_TITLE: "x-title",
} as const;

/** Media types used in more than one module. */
export const MIME = {
  JSON: "application/json",
  JSON_UTF8: "application/json; charset=utf-8",
  OCTET_STREAM: "application/octet-stream",
  PDF: "application/pdf",
  PNG: "image/png",
  MULTIPART_FORM_DATA: "multipart/form-data",
  EVENT_STREAM: "text/event-stream",
  EVENT_STREAM_UTF8: "text/event-stream; charset=utf-8",
  HTML: "text/html",
  TEXT_UTF8: "text/plain; charset=utf-8",
} as const;
