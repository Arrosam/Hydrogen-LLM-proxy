import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization";
import { SESSION_COOKIE } from "../../auth/session";
import { BackupError, exportBackup, restoreBackup } from "../../backup/archive";
import type { Container } from "../../composition/container";
import { PassphraseError } from "../../security/passphrase";
import { parse } from "../../util/validate";
import { APP_VERSION } from "../../util/version";

// --- backup / restore --------------------------------------------------------

/** A passphrase this short is not worth the scrypt call protecting it. */
const MIN_PASSPHRASE = 8;

const BackupExport = z.object({
  passphrase: z.string().min(MIN_PASSPHRASE, `passphrase must be at least ${MIN_PASSPHRASE} characters`),
  includeLogs: z.boolean().optional(),
  /** Defaults to off: the cache is regenerable, and at its default 64 MB budget
   * it can be larger than everything else in the package put together. */
  includeImageCache: z.boolean().optional(),
});
const BackupRestore = z.object({
  passphrase: z.string().min(1, "passphrase is required"),
  backup: z.unknown(),
});

/**
 * A package with request logs is far larger than any other admin payload (the
 * global cap is sized for chat requests, not for an instance's whole history),
 * so restore gets its own limit.
 */
const RESTORE_BODY_LIMIT = 512 * 1024 * 1024;

export async function backupRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.post("/export", async (req, reply) => {
    if (!requireAdmin(req, reply, "export a backup")) return reply;
    const parsed = parse(BackupExport, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const pkg = await exportBackup(c.sqlite, c.config.masterKey, {
      passphrase: parsed.data.passphrase,
      includeLogs: parsed.data.includeLogs ?? true,
      includeImageCache: parsed.data.includeImageCache ?? false,
      appVersion: APP_VERSION,
    });
    return { backup: pkg };
  });

  app.post("/restore", { bodyLimit: RESTORE_BODY_LIMIT }, async (req, reply) => {
    if (!requireAdmin(req, reply, "restore a backup")) return reply;
    if (c.activeRequests.listActive().length) return reply.code(409).send({ error: "Wait for active requests to finish or cancel them before restoring a backup" });
    const parsed = parse(BackupRestore, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    let report;
    c.responses.beginRestore();
    try {
      report = await restoreBackup(c.sqlite, c.config.masterKey, parsed.data.backup, parsed.data.passphrase);
    } catch (e) {
      // A bad passphrase or a malformed package is the caller's mistake, not a
      // server fault: 400 with the reason, and the database is untouched.
      if (e instanceof PassphraseError || e instanceof BackupError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    } finally {
      c.responses.endRestore();
    }
    // The settings table was replaced underneath the cached allowlist.
    c.settings.reload();
    // A package that carried request logs replaced the table the stats counters
    // describe -- rebuild them from the restored rows. A config-only package
    // left the log alone, so the accumulated history stays.
    if (report.includedLogs) c.statsCache.rebuild();
    // Both halves of the budget just changed under each other: the package
    // brought its own image_cache_max_bytes, and possibly its own cache rows,
    // neither of which knows what the other instance was sized for. Re-enforce
    // it against the restored setting so the cache can never sit over budget
    // waiting for the next OCR request to notice.
    const evicted = c.imageCache.enforceBudget(c.settings.imageCacheMaxBytes());
    if (evicted > 0) {
      req.log.info({ evicted }, "image cache trimmed to the restored budget");
    }
    // The users table is gone with everything else, so EVERY existing session now
    // refers to a row that may not exist (or worse, a different account at the
    // same id). Invalidate them all instance-wide, not just this caller's cookie:
    // move the session cutoff past every token issued so far, then clear the
    // caller's own cookie so they re-authenticate against the restored accounts.
    c.settings.bumpSessionEpoch(Date.now());
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true, ...report };
  });
}
