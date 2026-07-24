import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import path from "node:path";
import fs from "node:fs";
import { resolveWebDir } from "./util/paths";
import type { Container } from "./composition/container";
import { adminRoutes } from "./transport/adminRoutes";
import { ProxyController } from "./transport/proxyController";
import { MediaController } from "./transport/mediaController";

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB (allow image payloads)

export async function buildApp(c: Container): Promise<FastifyInstance> {
  const cfg = c.config;
  const app = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: true,
    logger: { level: cfg.isProduction ? "info" : "debug" },
  });

  await app.register(fastifyCookie, { secret: cfg.sessionSecret });
  await app.register(fastifyRateLimit, { global: false, max: 100, timeWindow: "1 minute" });

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
    }
    const msg = err.message || "";
    if (/UNIQUE constraint failed/i.test(msg)) {
      return reply.code(409).send({ error: "resource already exists (unique constraint)" });
    }
    if (/FOREIGN KEY constraint failed/i.test(msg)) {
      return reply.code(409).send({ error: "referenced resource is in use or missing" });
    }
    req.log.error({ err }, "unhandled error");
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    return reply.code(status).send({ error: status >= 500 ? "internal server error" : msg });
  });

  // `build` is the git SHA baked in at image build time (GIT_SHA build arg),
  // so a deployment can be checked against the repo: without it there is no
  // way to tell whether a fix is actually running.
  app.get("/healthz", async () => ({ status: "ok", build: process.env.GIT_SHA || "dev" }));

  // Speech-to-text passthrough forwards multipart bodies verbatim; buffer them
  // raw (Fastify has no default parser for this content type).
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  const proxyDeps = {
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
  };
  new ProxyController(proxyDeps).register(app);
  new MediaController({ ...proxyDeps, providers: c.providers }).register(app);

  await app.register((scoped) => adminRoutes(scoped, c), { prefix: "/admin/api" });

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
    if (req.url.startsWith("/v1") || req.url.startsWith("/admin/api") || req.url.startsWith("/healthz")) {
      return reply.code(404).send({ error: "not found" });
    }
    if (req.method !== "GET" || !fs.existsSync(indexHtml)) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.type("text/html").send(fs.readFileSync(indexHtml));
  });
}
