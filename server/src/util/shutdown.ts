/** The signals a supervisor stops the process with. */
export const SIGNAL = { TERM: "SIGTERM", INT: "SIGINT" } as const;

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
 * Returns true when the deadline had to force the drain. Async handlers may
 * still be pending then: the caller MUST perform only synchronous cleanup and
 * immediately exit, without yielding back to the event loop.
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

/** What the process holds open besides the HTTP server. */
export interface ShutdownResources {
  statsCache: { flush(): void };
  egressPool: { closeAll(): Promise<void> };
  sqlite: { close(): void };
}

/**
 * The whole shutdown sequence short of exiting: drain the server within
 * `graceMs`, flush the stats cache, tear down the pooled egress-proxy
 * dispatchers, close the database.
 *
 * The pool goes after the drain, because in-flight requests are still reading
 * through it until then. After a forced drain (or a close that threw) only
 * synchronous cleanup is allowed -- see closeWithDeadline -- so its teardown is
 * started and not awaited; the caller exits right after.
 */
export async function shutdownGracefully(app: ClosableServer, resources: ShutdownResources, graceMs: number): Promise<void> {
  let forced = true;
  try {
    forced = await closeWithDeadline(app, graceMs);
    resources.statsCache.flush();
  } finally {
    try {
      const pooled = resources.egressPool.closeAll().catch(() => undefined);
      if (!forced) await pooled;
    } finally {
      resources.sqlite.close();
    }
  }
}
