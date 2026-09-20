import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../auth/authorization";
import type { Container } from "../../composition/container";

// --- updates ------------------------------------------------------------------

export async function updateRoutes(app: FastifyInstance, c: Container): Promise<void> {
  // Latest-release status. Cached server-side; ?refresh=1 forces a refetch
  // (the "Check now" button), still admin-gated so the GitHub rate budget
  // cannot be drained through this proxy by ordinary users.
  app.get("/check", async (req, reply) => {
    if (!requireAdmin(req, reply, "check for updates")) return reply;
    const refresh = (req.query as Record<string, string>).refresh === "1";
    return c.updates.check(refresh);
  });

  // Restart-to-upgrade: reply, then shut down cleanly and let the supervisor
  // start the replacement. The endpoint is disabled unless the operator has
  // explicitly asserted that the deployment supervisor can do that safely.
  app.post("/restart", async (req, reply) => {
    if (!requireAdmin(req, reply, "restart the server")) return reply;
    if (!c.updates.restartSupported) {
      return reply.code(409).send({
        error: "remote restart is disabled for this deployment; update and restart it through its supervisor",
      });
    }
    req.log.warn({ user: req.user.username }, "restart-to-upgrade requested from the settings page");
    c.updates.scheduleRestart();
    return { restarting: true };
  });
}
