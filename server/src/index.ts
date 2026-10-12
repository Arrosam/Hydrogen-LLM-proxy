import { boot } from "./composition/container";
import { buildApp } from "./app";
import { LOG_RETENTION_DAYS_KEY } from "./persistence/settingsRepo";
import { shutdownGracefully, SIGNAL } from "./util/shutdown";
import { ensureHeapSized } from "./util/heap";
import { MS_PER_DAY } from "./util/time";

const SHUTDOWN_GRACE_MS = 30_000;
const LOG_PRUNE_INTERVAL_MS = MS_PER_DAY;

async function main(): Promise<void> {
  const container = await boot();
  const app = await buildApp(container);

  await app.listen({ port: container.config.port, host: container.config.host });
  app.log.info(`Hydrogen listening on http://${container.config.host}:${container.config.port}`);

  // Auto-prune the request log by age. The retention (log_retention_days, 0 =
  // keep forever) is re-read on every tick, so changing it in the dashboard
  // takes effect without a restart.
  const pruneTick = (): void => {
    const days = Number(container.settings.get(LOG_RETENTION_DAYS_KEY) ?? 0);
    if (!Number.isFinite(days) || days <= 0) return;
    try {
      const n = container.pruner.pruneOlderThan(days);
      if (n) app.log.info(`log prune: removed ${n} entries older than ${days}d`);
    } catch (e) {
      app.log.error({ err: e }, "log prune failed");
    }
  };
  pruneTick();
  const pruneTimer = setInterval(pruneTick, LOG_PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal}, shutting down`);
    if (pruneTimer) clearInterval(pruneTimer);
    try {
      await shutdownGracefully(app, container, SHUTDOWN_GRACE_MS);
    } finally {
      process.exit(0);
    }
  };
  process.on(SIGNAL.TERM, () => void shutdown(SIGNAL.TERM));
  process.on(SIGNAL.INT, () => void shutdown(SIGNAL.INT));
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
