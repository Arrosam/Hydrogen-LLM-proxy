import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, RequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { extractPresentedToken } from "../auth/tokenAuth";
import { tokenAllowsService } from "../auth/authorization";
import { ToolDirectory } from "../discovery/toolDirectory";
import type { HostedToolRepo } from "../persistence/hostedToolRepo";
import type { ServiceRepo } from "../persistence/serviceRepo";
import type { TokenRepo } from "../persistence/tokenRepo";
import pkg from "../../package.json";

interface DiscoveryDeps { services: ServiceRepo; tools: HostedToolRepo; tokens: TokenRepo; cursorKey: string; }

function rpcError(reply: FastifyReply, status: number, body: unknown, code: number, message: string) {
  const id = body && typeof body === "object" && "id" in body ? body.id : null;
  return reply.code(status).send({ jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null, error: { code, message } });
}

/** Per-target configuration discovery. Only the official SDK's init/list
 * protocol machinery is exposed; business tool executors are never wired. */
export async function toolDiscoveryRoutes(app: FastifyInstance, deps: DiscoveryDeps): Promise<void> {
  const directory = new ToolDirectory({ services: deps.services, tools: deps.tools }, deps.cursorKey);
  const authorize = (req: FastifyRequest) => {
    const presented = extractPresentedToken(req);
    const key = presented ? deps.tokens.authenticate(presented) : undefined;
    const expires = key?.expiresAt instanceof Date ? key.expiresAt.getTime() : key?.expiresAt;
    if (!key?.enabled || expires != null && expires < Date.now()) throw new McpError(-32001, "Invalid or expired API key.", { status: 401 });
    const name = (req.params as { serviceName: string }).serviceName;
    const row = deps.services.getByName(name);
    if (!row?.enabled) throw new McpError(-32004, "Target service is unavailable.", { status: 404 });
    if (!tokenAllowsService(key, row.id)) throw new McpError(-32003, "API key cannot access this target service.", { status: 403 });
    return { key, row };
  };
  app.addHook("onRequest", async (_req, reply) => { reply.header("Cache-Control", "no-store"); });
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    const status = error.statusCode ?? 500;
    return rpcError(reply, status, req.body, status >= 500 ? ErrorCode.InternalError : ErrorCode.ParseError,
      status >= 500 ? "Tool discovery is unavailable." : "Invalid MCP HTTP request.");
  });
  app.addHook("preHandler", async (req, reply) => {
    // Native clients/query tools do not send Origin. Reject browser origins;
    // do not implicitly grant cross-origin use of an existing Hydrogen Key.
    if (req.headers.origin !== undefined) return rpcError(reply, 403, req.body, -32003, "Browser Origin requests are unsupported.");
    try { authorize(req); }
    catch (error) {
      const mcp = error instanceof McpError ? error : new McpError(ErrorCode.InternalError, "Tool discovery is unavailable.");
      const status = (mcp.data as { status?: number } | undefined)?.status ?? 500;
      return rpcError(reply, status, req.body, mcp.code, mcp.message);
    }
  });
  const path = "/v1/services/:serviceName/mcp";
  app.route({ method: ["GET", "DELETE"], url: path, exposeHeadRoute: false, handler: (req, reply) => {
    reply.header("Allow", "POST");
    return rpcError(reply, 405, req.body, ErrorCode.MethodNotFound, "Stateless discovery supports POST requests only.");
  } });
  app.post(path, { bodyLimit: 65_536 }, async (req, reply) => {
    // The SDK retains legacy JSON-RPC batch support. Current Streamable HTTP
    // requires one message per POST; keep that boundary ahead of dispatch.
    if (Array.isArray(req.body)) return rpcError(reply, 400, undefined, ErrorCode.InvalidRequest, "MCP discovery accepts one message per POST.");
    const server = new Server({ name: "hydrogen-tool-discovery", version: pkg.version }, {
      capabilities: { tools: { listChanged: false } },
      instructions: "Read-only discovery of the target service's current configuration. Every entry is discovery-only and tools/call always fails. Unknown upstream schemas are format placeholders, not callable contracts. Custom metadata may be ignored by clients. Pagination is live: configuration edits can cause duplicates or omissions between pages.",
    });
    // The low-level SDK maps a thrown schema parse error to InternalError.
    // Use its generic request schema, then its list schema's safeParse so
    // invalid paging parameters produce the specified InvalidParams error.
    server.setRequestHandler(RequestSchema.extend({ method: ListToolsRequestSchema.shape.method }), request => {
      const parsed = ListToolsRequestSchema.safeParse(request);
      if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, "Invalid tools/list parameters.");
      try {
        const { key, row } = authorize(req); // Re-read authorization and target at list dispatch as well.
        return directory.list(row, key.id, parsed.data.params?.cursor);
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, "Tool discovery is unavailable.");
      }
    });
    server.setRequestHandler(RequestSchema.extend({ method: CallToolRequestSchema.shape.method }), () => {
      throw new McpError(ErrorCode.MethodNotFound, "tools/call is unsupported: this endpoint provides read-only discovery only.");
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await server.close(); } };
    req.raw.once("aborted", () => { void close(); });
    reply.raw.once("close", () => { void close(); });
    await server.connect(transport);
    reply.raw.setHeader("Cache-Control", "no-store");
    reply.raw.setHeader("X-Content-Type-Options", "nosniff");
    reply.hijack();
    try { await transport.handleRequest(req.raw, reply.raw, req.body); }
    finally { await close(); }
  });
}
