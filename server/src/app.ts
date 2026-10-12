import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import path from "node:path";
import fs from "node:fs";
import { resolveWebDir } from "./util/paths";
import { fuzzyRewriteUrl } from "./transport/fuzzyUrl";
import type { Container } from "./composition/container";
import { adminRoutes } from "./transport/adminRoutes";
import { ProxyController } from "./transport/proxyController";
import { ResponsesController } from "./transport/responsesController";
import { MediaController } from "./transport/mediaController";
import { notFound } from "./transport/admin/replies";
import { DEFAULT_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW } from "./transport/rateLimits";
import { ADMIN_API_PREFIX, API_PREFIX, HEALTH_PATH } from "./transport/routes";
import { BYTES_PER_MIB } from "./config/limits";
import { MIME } from "./util/httpHeaders";
import { HTTP_STATUS, isServerErrorStatus } from "./util/httpStatus";
import { DEV_BUILD_SHA } from "./util/version";

const MAX_BODY_BYTES = 25 * BYTES_PER_MIB; // 25 MiB (allow image payloads)

export async function buildApp(c: Container): Promise<FastifyInstance> {
  const cfg = c.config;
  const app = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    // Honour X-Forwarded-* only as far as the operator declared (TRUST_PROXY).
    // Trusting unconditionally would let a directly exposed instance rotate
    // its rate-limit key with a spoofed X-Forwarded-For. proxy-addr accepts a
    // numeric hop count at runtime, but Fastify 5.12's ServerOptions type
    // narrowed the union to boolean/string -- hence the cast.
    trustProxy: cfg.trustProxy as FastifyServerOptions["trustProxy"],
    logger: { level: cfg.isProduction ? "info" : "debug" },
    // Fuzzy endpoint adapter: forgive doubled slashes, a missing /v1, or a
    // bare base URL by rewriting onto the canonical route before routing.
    rewriteUrl(req) {
      return fuzzyRewriteUrl(req.method, req.url, req.headers);
    },
  });

  await app.register(fastifyCookie, { secret: cfg.sessionSecret });
  await app.register(fastifyRateLimit, { global: false, max: DEFAULT_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_WINDOW });

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: err.issues.map((i) => i.message).join("; ") });
    }
    const msg = err.message || "";
    if (/UNIQUE constraint failed/i.test(msg)) {
      return reply.code(HTTP_STATUS.CONFLICT).send({ error: "resource already exists (unique constraint)" });
    }
    if (/FOREIGN KEY constraint failed/i.test(msg)) {
      return reply.code(HTTP_STATUS.CONFLICT).send({ error: "referenced resource is in use or missing" });
    }
    req.log.error({ err }, "unhandled error");
    const status = typeof err.statusCode === "number" ? err.statusCode : HTTP_STATUS.INTERNAL_SERVER_ERROR;
    return reply.code(status).send({ error: isServerErrorStatus(status) ? "internal server error" : msg });
  });

  // `build` is the git SHA baked in at image build time (GIT_SHA build arg),
  // so a deployment can be checked against the repo: without it there is no
  // way to tell whether a fix is actually running.
  app.get(HEALTH_PATH, async () => ({ status: "ok", build: process.env.GIT_SHA || DEV_BUILD_SHA }));

  // Speech-to-text passthrough forwards multipart bodies verbatim; buffer them
  // raw (Fastify has no default parser for this content type).
  app.addContentTypeParser(MIME.MULTIPART_FORM_DATA, { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  const proxyDeps = {
    logMaxChars: () => c.settings.logPayloadMaxChars(),
    services: c.services,
    factory: c.factory,
    tokens: c.tokens,
    catalog: c.catalog,
    transport: c.transport,
    logger: c.requestLogger,
    usage: c.usageMeter,
    activeRequests: c.activeRequests,
    streamCommitGraceMs: cfg.streamCommitGraceMs,
    streamPingIntervalMs: cfg.streamPingIntervalMs,
    jsonCommitGraceMs: cfg.jsonCommitGraceMs,
  };
  const responses = new ResponsesController(proxyDeps, c.responses, c.hostedTools);
  responses.register(app);
  new ProxyController(proxyDeps, responses).register(app);
  new MediaController({ ...proxyDeps, providers: c.providers }).register(app);

  await app.register((scoped) => adminRoutes(scoped, c), { prefix: ADMIN_API_PREFIX });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    if (req.method === "GET" && !req.url.startsWith(API_PREFIX) && !req.url.startsWith(ADMIN_API_PREFIX)) {
      reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    }
    return payload;
  });
  await registerWebDashboard(app);

  return app;
}

/** Serve the built SPA (if present) with client-side-routing fallback. */
async function registerWebDashboard(app: FastifyInstance): Promise<void> {
  const webDir = resolveWebDir();
  if (!webDir) {
    app.log.warn("web dashboard build not found; UI will not be served (dev uses the Vite server)");
    return;
  }
  await app.register(fastifyStatic, { root: webDir, wildcard: false });

  const indexHtml = path.join(webDir, "index.html");
  app.setNotFoundHandler((req, reply) => {
    // An API path never falls back to the SPA; neither does a non-GET.
    const isApiPath = req.url.startsWith(API_PREFIX) || req.url.startsWith(ADMIN_API_PREFIX) || req.url.startsWith(HEALTH_PATH);
    if (isApiPath || req.method !== "GET" || !fs.existsSync(indexHtml)) return notFound(reply);
    return reply.type(MIME.HTML).send(fs.readFileSync(indexHtml));
  });
}
