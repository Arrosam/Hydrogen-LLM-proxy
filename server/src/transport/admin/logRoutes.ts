import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../auth/authorization";
import type { Container } from "../../composition/container";
import { idParam } from "../../util/validate";

// --- logs + stats -----------------------------------------------------------

function numParam(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function boolParam(v: unknown): boolean | undefined {
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

// Request logs carry every caller's full conversation payload, so reading them
// is an admin capability. Stats and active-request progress stay visible to
// every dashboard user: they hold counters and metadata, not content.
export async function logRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/logs", async (req, reply) => {
    if (!requireAdmin(req, reply, "view request logs")) return reply;
    const q = req.query as Record<string, string>;
    return c.logs.query({
      tokenId: numParam(q.tokenId),
      serviceId: numParam(q.serviceId),
      status: numParam(q.status),
      errorsOnly: boolParam(q.errorsOnly),
      from: numParam(q.from),
      to: numParam(q.to),
      limit: numParam(q.limit),
      offset: numParam(q.offset),
    });
  });

  app.get("/logs/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "view request logs")) return reply;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const log = c.logs.get(id);
    if (!log) return reply.code(404).send({ error: "not found" });
    return { log };
  });

  // Clear the entire request log (and reclaim the file space).
  app.delete("/logs", async (req, reply) => {
    if (!requireAdmin(req, reply, "clear logs")) return reply;
    const deleted = c.logs.deleteAll();
    c.statsCache.reset();
    try {
      c.sqlite.exec("VACUUM");
    } catch {
      /* best-effort space reclaim; the rows are already gone */
    }
    return { deleted };
  });

  // The unbounded queries the dashboard actually issues come straight from the
  // in-memory StatsCache -- no SQL per view. An explicit from/to still runs the
  // SQL aggregation, since the cache only accumulates all-time totals.
  const range = (req: { query: unknown }): { from?: number; to?: number } => {
    const q = req.query as Record<string, string>;
    return { from: numParam(q.from), to: numParam(q.to) };
  };
  const bounded = (r: { from?: number; to?: number }): boolean => r.from != null || r.to != null;
  app.get("/stats/summary", async (req) => {
    const r = range(req);
    return bounded(r) ? c.stats.summary(r) : c.statsCache.summary();
  });
  app.get("/stats/timeseries", async (req) => {
    const r = range(req);
    return { points: bounded(r) ? c.stats.timeSeries(r) : c.statsCache.timeSeries() };
  });
  app.get("/stats/by-service", async (req) => {
    const r = range(req);
    return { groups: bounded(r) ? c.stats.byService(r) : c.statsCache.byService() };
  });
  app.get("/stats/by-model-provider", async (req) => {
    const r = range(req);
    return bounded(r) ? c.stats.byModelProvider(r) : c.statsCache.byModelProvider();
  });
}
