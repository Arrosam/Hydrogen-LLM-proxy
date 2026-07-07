import { bootstrap } from "./bootstrap";
import { buildApp } from "./app";
import { closeDatabase } from "./db";

async function main(): Promise<void> {
  const { config } = await bootstrap();
  const app = await buildApp();

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Hydrogen listening on http://${config.host}:${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      closeDatabase();
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
