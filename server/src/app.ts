import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import path from "node:path";
import fs from "node:fs";
import { getConfig } from "./context";
import { resolveWebDir } from "./util/paths";
import { adminRoutes } from "./routes/admin";
import { proxyRoutes } from "./routes/proxy";

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB (allow image payloads)

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = getConfig();
  const app = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: true,
    logger: { level: cfg.isProduction ? "info" : "debug" },
  });

  await app.register(fastifyCookie, { secret: cfg.sessionSecret });
  await app.register(fastifyRateLimit, { global: false, max: 100, timeWindow: "1 minute" });

  // Uniform error handling.
  app.setErrorHandler((err: FastifyError, req, reply) => {
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

  app.get("/healthz", async () => ({ status: "ok" }));

  await app.register(proxyRoutes);
  await app.register(adminRoutes, { prefix: "/admin/api" });

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
    // API routes should 404 as JSON; everything else falls back to the SPA.
    if (req.url.startsWith("/v1") || req.url.startsWith("/admin/api") || req.url.startsWith("/healthz")) {
      return reply.code(404).send({ error: "not found" });
    }
    if (req.method !== "GET" || !fs.existsSync(indexHtml)) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.type("text/html").send(fs.readFileSync(indexHtml));
  });
}
