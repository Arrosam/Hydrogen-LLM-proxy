import { z } from "zod";
import type { Transport } from "../core/upstream/transport";

const MAX_REQUEST_BYTES = 1_048_576;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "trailer"]);

export const HttpToolSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  description: z.string().max(8_000).default(""),
  parameters: z.record(z.string(), z.unknown()).refine(s => s.type === "object", "Tool parameters must be an object JSON Schema"),
  url: z.string().url().max(4_096).refine(value => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
    } catch { return false; }
  }, "Use an HTTP(S) URL without embedded credentials or a fragment"),
  headers: z.record(z.string(), z.string().max(8_192)).default({}).refine(headers =>
    Object.entries(headers).every(([key, value]) => HEADER_NAME.test(key) && !RESERVED_HEADERS.has(key.toLowerCase()) && !/[\r\n\0]/.test(value)),
  "Invalid or reserved HTTP header"),
  bodyTemplate: z.unknown().refine(value => value != null && typeof value === "object" && !Array.isArray(value), "Request template must be a JSON object"),
  /** JSON Pointer: empty selects the entire JSON response; /data/result selects a nested value. */
  resultPath: z.string().max(1_024).default("").refine(path => path === "" || (path.startsWith("/") && !/~(?![01])/.test(path)), "Use a JSON Pointer such as /data/result"),
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
  maxResultBytes: z.number().int().min(1).max(1_048_576).default(65_536),
  enabled: z.boolean().default(true),
});

export type HttpTool = z.infer<typeof HttpToolSchema>;

export interface ToolCallContext {
  arguments: Record<string, unknown>;
  tool: { name: string };
  call: { id: string };
  session: { id: string };
}

export class ToolTemplateError extends Error {}

function ownPath(value: unknown, segments: string[]): unknown {
  let selected = value;
  for (const key of segments) {
    if (selected === null || typeof selected !== "object" || !Object.hasOwn(selected, key)) {
      throw new ToolTemplateError(`Missing value at ${segments.join(".")}`);
    }
    selected = (selected as Record<string, unknown>)[key];
  }
  if (selected === undefined) throw new ToolTemplateError("Template values must be JSON values");
  return selected;
}

/** No eval or expressions. A whole placeholder preserves JSON type. */
export function renderToolBody(template: unknown, context: ToolCallContext): Record<string, unknown> {
  let nodes = 0;
  const variable = (path: string): unknown => {
    const segments = path.trim().split(".");
    if (!["arguments", "tool", "call", "session"].includes(segments[0]) || segments.some(key => !/^[A-Za-z0-9_-]+$/.test(key))) {
      throw new ToolTemplateError(`Invalid template variable: ${path}`);
    }
    return ownPath(context, segments);
  };
  const render = (value: unknown, depth: number): unknown => {
    if (++nodes > 10_000 || depth > 32) throw new ToolTemplateError("Request template is too complex");
    if (typeof value === "string") {
      const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
      if (whole) return variable(whole[1]);
      return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path: string) => {
        const result = variable(path);
        if (result !== null && typeof result === "object") throw new ToolTemplateError("Objects and arrays require a whole-value placeholder");
        return String(result);
      });
    }
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
    if (Array.isArray(value)) return value.map(item => render(item, depth + 1));
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, depth + 1)]));
    throw new ToolTemplateError("Request template must contain JSON values only");
  };
  const rendered = render(template, 0);
  if (rendered === null || typeof rendered !== "object" || Array.isArray(rendered)) throw new ToolTemplateError("Request body must be a JSON object");
  // Round-trip to reject cycles/non-JSON values and detach model parameters from mutable callers.
  const encoded = JSON.stringify(rendered);
  if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw new ToolTemplateError("Tool request exceeds 1 MiB");
  return JSON.parse(encoded) as Record<string, unknown>;
}

export function selectToolResult(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) throw new ToolTemplateError("Invalid result JSON Pointer");
  return ownPath(value, pointer.slice(1).split("/").map(key => key.replace(/~1/g, "/").replace(/~0/g, "~")));
}

export interface HttpToolResult {
  output: string;
  isError: boolean;
  status?: number;
  durationMs: number;
}

/** A single POST, without retries or redirect following. The injected transport pins SSRF-checked DNS. */
export async function callHttpTool(
  tool: HttpTool,
  context: ToolCallContext,
  transport: Pick<Transport, "postStream">,
  signal?: AbortSignal,
): Promise<HttpToolResult> {
  const started = Date.now();
  const failure = (code: string, message: string, status?: number): HttpToolResult => ({
    output: JSON.stringify({ error: { code, message } }), isError: true, status, durationMs: Date.now() - started,
  });
  signal?.throwIfAborted();
  if (!tool.enabled) return failure("tool_disabled", "This tool is disabled");
  let body: Record<string, unknown>;
  try {
    body = renderToolBody(tool.bodyTemplate, context);
  } catch {
    return failure("invalid_arguments", "Tool arguments do not match its request template");
  }
  const timeout = AbortSignal.timeout(tool.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Awaited<ReturnType<Transport["postStream"]>> | undefined;
  try {
    const headers = Object.fromEntries(Object.entries(tool.headers).map(([key, value]) => [key.toLowerCase(), value]));
    response = await transport.postStream(tool.url, { ...headers, "content-type": "application/json", accept: "application/json" }, body, {
      timeoutMs: tool.timeoutMs, signal: combined, proxy: null,
    });
    if (response.status < 200 || response.status >= 300) return failure("http_error", `Tool API returned HTTP ${response.status}`, response.status);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      combined.throwIfAborted();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > tool.maxResultBytes) return failure("result_too_large", "Tool response exceeds its configured byte limit", response.status);
      chunks.push(buffer);
    }
    combined.throwIfAborted();
    let selected: unknown;
    try {
      selected = selectToolResult(JSON.parse(Buffer.concat(chunks).toString("utf8")), tool.resultPath);
    } catch {
      return failure("invalid_result", "Tool API did not return JSON matching its result path", response.status);
    }
    return { output: typeof selected === "string" ? selected : JSON.stringify(selected), isError: false, status: response.status, durationMs: Date.now() - started };
  } catch {
    signal?.throwIfAborted();
    return failure(timeout.aborted ? "tool_timeout" : "tool_connection_error", timeout.aborted ? "Tool API timed out" : "Tool API request failed");
  } finally {
    response?.body.destroy();
  }
}
