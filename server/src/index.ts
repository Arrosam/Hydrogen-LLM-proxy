import { boot } from "./composition/container";
import { buildApp } from "./app";

async function main(): Promise<void> {
  const container = await boot();
  const app = await buildApp(container);

  await app.listen({ port: container.config.port, host: container.config.host });
  app.log.info(`Hydrogen listening on http://${container.config.host}:${container.config.port}`);

  // Optional auto-pruning of the request log by age (setting log_retention_days > 0).
  const retentionDays = Number(container.settings.get("log_retention_days") ?? 0);
  let pruneTimer: NodeJS.Timeout | undefined;
  if (Number.isFinite(retentionDays) && retentionDays > 0) {
    const run = (): void => {
      try {
        container.pruner.pruneOlderThan(retentionDays);
      } catch (e) {
        app.log.error({ err: e }, "log prune failed");
      }
    };
    run();
    pruneTimer = setInterval(run, 24 * 60 * 60 * 1000);
    pruneTimer.unref?.();
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    if (pruneTimer) clearInterval(pruneTimer);
    try {
      await app.close();
      container.sqlite.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:\n", err instanceof Error ? err.message : err);
  process.exit(1);
});
