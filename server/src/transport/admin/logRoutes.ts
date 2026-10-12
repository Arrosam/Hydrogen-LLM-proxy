import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../auth/authorization";
import type { Container } from "../../composition/container";
import { boolParam, numParam } from "../../util/validate";
import { loadById } from "./replies";

const ACTION_VIEW_LOGS = "view request logs";

// --- logs + stats -----------------------------------------------------------

// Request logs carry every caller's full conversation payload, so reading them
// is an admin capability. Stats and active-request progress stay visible to
// every dashboard user: they hold counters and metadata, not content.
export async function logRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/logs", async (req, reply) => {
    if (!requireAdmin(req, reply, ACTION_VIEW_LOGS)) return reply;
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
    if (!requireAdmin(req, reply, ACTION_VIEW_LOGS)) return reply;
    const hit = loadById(req, reply, (id) => c.logs.get(id));
    if (!hit) return reply;
    return { log: hit.row };
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
  type StatsRange = { from?: number; to?: number };
  const range = (req: { query: unknown }): StatsRange => {
    const q = req.query as Record<string, string>;
    return { from: numParam(q.from), to: numParam(q.to) };
  };
  const bounded = (r: StatsRange): boolean => r.from != null || r.to != null;
  const stat = <T>(req: { query: unknown }, aggregate: (r: StatsRange) => T, cached: () => T): T => {
    const r = range(req);
    return bounded(r) ? aggregate(r) : cached();
  };
  app.get("/stats/summary", async (req) => stat(req, (r) => c.stats.summary(r), () => c.statsCache.summary()));
  app.get("/stats/timeseries", async (req) => ({ points: stat(req, (r) => c.stats.timeSeries(r), () => c.statsCache.timeSeries()) }));
  app.get("/stats/by-service", async (req) => ({ groups: stat(req, (r) => c.stats.byService(r), () => c.statsCache.byService()) }));
  app.get("/stats/by-model-provider", async (req) => stat(req, (r) => c.stats.byModelProvider(r), () => c.statsCache.byModelProvider()));
}
