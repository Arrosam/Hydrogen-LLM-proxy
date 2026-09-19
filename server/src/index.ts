import { boot } from "./composition/container";
import { buildApp } from "./app";
import { closeWithDeadline } from "./util/shutdown";
import { ensureHeapSized } from "./util/heap";

const SHUTDOWN_GRACE_MS = 30_000;

async function main(): Promise<void> {
  const container = await boot();
  const app = await buildApp(container);

  await app.listen({ port: container.config.port, host: container.config.host });
  app.log.info(`Hydrogen listening on http://${container.config.host}:${container.config.port}`);

  // Auto-prune the request log by age. The retention (log_retention_days, 0 =
  // keep forever) is re-read on every tick, so changing it in the dashboard
  // takes effect without a restart.
  const pruneTick = (): void => {
    const days = Number(container.settings.get("log_retention_days") ?? 0);
    if (!Number.isFinite(days) || days <= 0) return;
    try {
      const n = container.pruner.pruneOlderThan(days);
      if (n) app.log.info(`log prune: removed ${n} entries older than ${days}d`);
    } catch (e) {
      app.log.error({ err: e }, "log prune failed");
    }
  };
  pruneTick();
  const pruneTimer = setInterval(pruneTick, 24 * 60 * 60 * 1000);
  pruneTimer.unref?.();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal}, shutting down`);
    if (pruneTimer) clearInterval(pruneTimer);
    try {
      await closeWithDeadline(app, SHUTDOWN_GRACE_MS);
      container.statsCache.flush();
    } finally {
      try {
        container.sqlite.close();
      } finally {
        process.exit(0);
      }
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Size V8's heap to the container BEFORE the app allocates anything. When the
// limit is detected and Node was not already given a ceiling, this re-execs and
// the parent becomes a signal-forwarding supervisor; otherwise it returns false
// and this process runs the app directly.
if (ensureHeapSized()) {
  // A container-sized child is running; the parent only supervises it.
} else {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Fatal startup error:\n", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
