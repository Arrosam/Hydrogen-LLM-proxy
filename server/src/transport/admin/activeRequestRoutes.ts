import type { FastifyInstance } from "fastify";
import type { Container } from "../../composition/container";
import { BLOCK_THRESHOLD_MS } from "../../observability/activeRequests";

// --- active requests (real-time monitoring) ----------------------------------

/** Serialize an ActiveRequest for the API (with computed fields for the UI). */
function serializeActive(r: import("../../observability/activeRequests").ActiveRequest, now: number) {
  const elapsedMs = now - r.startedAt;
  const lastEvent = r.events.length > 0 ? r.events[r.events.length - 1] : null;
  return {
    traceId: r.traceId,
    tokenId: r.tokenId,
    serviceId: r.serviceId,
    serviceName: r.serviceName,
    ingress: r.ingress,
    streaming: r.streaming,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    elapsedMs,
    blocked: !r.done && elapsedMs > BLOCK_THRESHOLD_MS,
    done: r.done,
    httpStatus: r.httpStatus,
    error: r.error,
    eventCount: r.events.length,
    lastPhase: lastEvent?.phase ?? null,
    lastNode: lastEvent?.node ?? null,
    lastMessage: lastEvent?.message ?? null,
    lastEventTs: lastEvent?.ts ?? null,
    events: r.events,
  };
}

export async function activeRequestRoutes(app: FastifyInstance, c: Container): Promise<void> {
  // List all in-flight requests + recently completed (for the real-time panel).
  app.get("/active-requests", async (req) => {
    const q = req.query as Record<string, string>;
    const now = Date.now();
    const active = c.activeRequests.listActive().map((r) => serializeActive(r, now));
    // Include recently completed (limit 20) so the UI can show what just finished.
    const completed = c.activeRequests.listCompleted(20).map((r) => serializeActive(r, now));

    // Optional filter by traceId (for single-request tracing).
    const traceFilter = q.traceId;
    if (traceFilter) {
      return {
        active: active.filter((r) => r.traceId === traceFilter),
        completed: completed.filter((r) => r.traceId === traceFilter),
        blockThresholdMs: BLOCK_THRESHOLD_MS,
        now,
      };
    }

    // Sort: blocked first, then by elapsed descending (longest running on top).
    active.sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
      return b.elapsedMs - a.elapsedMs;
    });

    return { active, completed, blockThresholdMs: BLOCK_THRESHOLD_MS, now };
  });

  // Get a single request by traceId (active or completed) with full event stream.
  app.get("/active-requests/:traceId", async (req, reply) => {
    const traceId = (req.params as { traceId?: string }).traceId;
    if (!traceId) return reply.code(400).send({ error: "missing traceId" });
    const r = c.activeRequests.get(traceId);
    if (!r) return reply.code(404).send({ error: "trace not found (may have expired from the ring buffer)" });
    return { request: serializeActive(r, Date.now()), blockThresholdMs: BLOCK_THRESHOLD_MS };
  });

  // Summary stats (counters for the dashboard).
  app.get("/active-requests/stats", async () => {
    const s = c.activeRequests.stats();
    const now = Date.now();
    const active = c.activeRequests.listActive();
    const blocked = active.filter((r) => now - r.startedAt > BLOCK_THRESHOLD_MS).length;
    return { ...s, blocked, blockThresholdMs: BLOCK_THRESHOLD_MS, now };
  });
}
