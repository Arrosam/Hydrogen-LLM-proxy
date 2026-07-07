import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the first existing directory from an ordered list of candidates
 * (each resolved relative to the current working directory). Used so the same
 * bundle works whether launched from the repo root (Docker: /app) or from the
 * `server` workspace during development.
 */
export function resolveExistingDir(candidates: (string | undefined)[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const abs = path.resolve(process.cwd(), c);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Location of the generated Drizzle migration files. */
export function resolveMigrationsDir(): string | null {
  return resolveExistingDir([
    process.env.MIGRATIONS_DIR,
    "server/drizzle",
    "drizzle",
    "server/dist/drizzle",
  ]);
}

/** Location of the built web dashboard (Vite output). */
export function resolveWebDir(): string | null {
  return resolveExistingDir([process.env.WEB_DIR, "web/dist", "../web/dist"]);
}

/** Ensure a directory exists, creating it (recursively) if needed. */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
