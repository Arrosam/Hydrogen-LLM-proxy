import type { FastifyInstance } from "fastify";
import { idParam } from "../../util/validate";
import { getLog, queryLogs, type LogQuery } from "../../services/logs";
import { byModelProvider, byService, summary, timeSeries, type StatsQuery } from "../../services/stats";

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

export async function logRoutes(app: FastifyInstance): Promise<void> {
  app.get("/logs", async (req) => {
    const q = req.query as Record<string, string>;
    const query: LogQuery = {
      tokenId: numParam(q.tokenId),
      serviceId: numParam(q.serviceId),
      status: numParam(q.status),
      errorsOnly: boolParam(q.errorsOnly),
      from: numParam(q.from),
      to: numParam(q.to),
      limit: numParam(q.limit),
      offset: numParam(q.offset),
    };
    return queryLogs(query);
  });

  app.get("/logs/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const log = getLog(id);
    if (!log) return reply.code(404).send({ error: "not found" });
    return { log };
  });

  const statsRange = (req: { query: unknown }): StatsQuery => {
    const q = req.query as Record<string, string>;
    return { from: numParam(q.from), to: numParam(q.to) };
  };

  app.get("/stats/summary", async (req) => summary(statsRange(req)));
  app.get("/stats/timeseries", async (req) => ({ points: timeSeries(statsRange(req)) }));
  app.get("/stats/by-service", async (req) => ({ groups: byService(statsRange(req)) }));
  app.get("/stats/by-model-provider", async (req) => byModelProvider(statsRange(req)));
}
