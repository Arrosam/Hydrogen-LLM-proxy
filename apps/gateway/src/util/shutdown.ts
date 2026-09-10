/** Minimal surface needed to drain Fastify without coupling the helper to its
 * concrete generic parameters. */
export interface ClosableServer {
  close(): Promise<unknown>;
  server: { closeAllConnections?: () => void };
  log: { warn(message: string): void };
}

/**
 * Begin Fastify's normal graceful close, but bound how long active requests can
 * hold the process open. At the deadline all HTTP connections are destroyed and
 * the promise resolves so the caller can close local resources and exit.
 *
 * Returns true when the deadline had to force the drain.
 */
export async function closeWithDeadline(app: ClosableServer, graceMs: number): Promise<boolean> {
  let forced = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      forced = true;
      app.log.warn(`shutdown grace period (${graceMs}ms) expired; closing active connections`);
      app.server.closeAllConnections?.();
      resolve();
    }, graceMs);
    timer.unref?.();
  });

  try {
    await Promise.race([app.close().then(() => undefined), deadline]);
    return forced;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
