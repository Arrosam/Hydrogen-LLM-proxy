import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the first existing directory from an ordered list of candidates
 * (each resolved relative to the current working directory). Used so the same
 * bundle works whether launched from the repo root (Docker: /app) or from the
 * gateway workspace during development.
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

/**
 * Location of the pre-split (v2.0.0 and earlier) Drizzle migration chain. It
 * is only ever applied to a COPY of a legacy hydrogen.db, to bring that copy
 * up to the last legacy schema before its rows are imported; the current
 * schema lives in each package's embedded migrations.
 */
export function resolveLegacyMigrationsDir(): string | null {
  return resolveExistingDir([
    process.env.LEGACY_MIGRATIONS_DIR,
    "apps/gateway/legacy-migrations",
    "legacy-migrations",
    "../gateway/legacy-migrations",
  ]);
}

/** Location of the built console (Vite output). */
export function resolveWebDir(): string | null {
  return resolveExistingDir([process.env.WEB_DIR, "apps/console/dist", "../console/dist", "console/dist", "web/dist"]);
}

/** Ensure a directory exists, creating it (recursively) if needed. */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
