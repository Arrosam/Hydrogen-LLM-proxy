import { boot } from "./composition/container";
import { buildApp } from "./app";
import { closeWithDeadline } from "./util/shutdown";
import { ensureHeapSized } from "./util/heap";
import path from "node:path";
import { startStatsReader } from "./persistence/statsReader";
import { startupStageAsync, type StartupReporter } from "./util/startup";

const SHUTDOWN_GRACE_MS = 30_000;

async function main(): Promise<void> {
  const report: StartupReporter = event => console.error(JSON.stringify(event));
  const container = await boot({ deferredStats: true, reportStartup: report });
  const app = await startupStageAsync(report, "app.build", () => buildApp(container));

  await startupStageAsync(report, "app.listen", () => app.listen({ port: container.config.port, host: container.config.host }));
  app.log.info(`Hydrogen listening on http://${container.config.host}:${container.config.port}`);

  // Auto-prune the request log by age. The retention (log_retention_days, 0 =
  // keep forever) is re-read on every tick, so changing it in the dashboard
  // takes effect without a restart.
  const pruneTick = (): void => {
    // The original startup seeded before pruning. Preserve that ordering while
    // the worker is pending/failed, or its historical rows could disappear.
    if (!container.statsCache.isReady) return;
    try {
      const days = Number(container.settings.get("log_retention_days") ?? 0);
      const maxRows = Number(container.settings.get("log_max_rows") ?? 100_000);
      const capped = container.pruner.capRows(Number.isSafeInteger(maxRows) && maxRows > 0 ? maxRows : 100_000);
      if (capped) app.log.info(`log prune: removed ${capped} entries above the row budget`);
      const n = Number.isFinite(days) && days > 0 ? container.pruner.pruneOlderThan(days) : 0;
      if (n) app.log.info(`log prune: removed ${n} entries older than ${days}d`);
    } catch (e) {
      app.log.error({ err: e }, "log prune failed");
    }
  };
  void container.statsCache.startDeferred((sinceId, throughId) =>
    startStatsReader(path.resolve(container.config.dataDir, "hydrogen.db"), sinceId, throughId, report),
  ).then(() => {
    if (container.statsCache.isReady) pruneTick();
    else app.log.warn("startup statistics unavailable; request logs retained for a future retry");
  });
  const pruneTimer = setInterval(pruneTick, 60 * 60 * 1000);
  pruneTimer.unref?.();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal}, shutting down`);
    if (pruneTimer) clearInterval(pruneTimer);
    try {
      await closeWithDeadline(app, SHUTDOWN_GRACE_MS);
      container.statsCache.close();
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
