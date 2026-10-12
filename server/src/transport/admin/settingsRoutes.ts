import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization";
import type { Container } from "../../composition/container";
import { parseAllowlistEntry } from "../../core/upstream/ssrf";
import { BYTES_PER_GIB } from "../../config/limits";
import { LOG_RETENTION_DAYS_KEY, RESPONSE_RETENTION_DAYS_KEY } from "../../persistence/settingsRepo";
import { MS_PER_DAY, MS_PER_MINUTE } from "../../util/time";
import { APP_VERSION } from "../../util/version";
import { badRequest, parseBody } from "./replies";

// --- settings ---------------------------------------------------------------

const MAX_ALLOWLIST_ENTRIES = 200;
const MAX_RETENTION_DAYS = 3650;
const MAX_LOG_PAYLOAD_CHARS = 10_000_000;
const MAX_SIMULATED_STREAMING_TOKEN_RATE = 1_000_000;
const MIN_SESSION_TTL_MS = MS_PER_MINUTE;
const MAX_SESSION_TTL_MS = 30 * MS_PER_DAY;
const MAX_PROMPT_CACHE_TTL_MINUTES = 24 * 60;

const ACTION_VIEW_SETTINGS = "view settings";

/** One grammar for the entry, shared with the SSRF guard that reads it back:
 * what the guard cannot parse matches nothing, so it is not accepted here. */
function isValidAllowlistEntry(raw: string): boolean {
  return parseAllowlistEntry(raw) !== null;
}

const AllowlistPut = z.object({ entries: z.array(z.string()).max(MAX_ALLOWLIST_ENTRIES) });
const RetentionPut = z.object({ days: z.number().int().min(0).max(MAX_RETENTION_DAYS) });
const UiLanguagePut = z.object({ language: z.enum(["en", "zh"]) });
const EnvSettingsPut = z.object({
  allowPrivateUpstreams: z.boolean().optional(),
  logPayloadMaxChars: z.number().int().min(0).max(MAX_LOG_PAYLOAD_CHARS).optional(),
  simulatedStreamingTokenRate: z.number().int().min(1).max(MAX_SIMULATED_STREAMING_TOKEN_RATE).optional(),
  sessionTtlMs: z.number().int().min(MIN_SESSION_TTL_MS).max(MAX_SESSION_TTL_MS).optional(),
  promptCacheTtlMinutes: z.number().int().min(1).max(MAX_PROMPT_CACHE_TTL_MINUTES).optional(),
});

/** 64 GiB — far past any sane cache, but a finite cap keeps a typo from being
 * read as "unbounded". 0 turns the cache off and empties it. */
const MAX_IMAGE_CACHE_BYTES = 64 * BYTES_PER_GIB;
const ImageCachePut = z.object({ maxBytes: z.number().int().min(0).max(MAX_IMAGE_CACHE_BYTES) });

export async function settingsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/response-retention", async (req, reply) => {
    if (!requireAdmin(req, reply, ACTION_VIEW_SETTINGS)) return reply;
    return { days: c.settings.responseRetentionDays() };
  });
  app.put("/response-retention", async (req, reply) => {
    if (!requireAdmin(req, reply, "change response retention")) return reply;
    const value = parseBody(RetentionPut, req, reply);
    if (!value) return reply;
    c.settings.set(RESPONSE_RETENTION_DAYS_KEY, String(value.days));
    c.responses.prune();
    return value;
  });
  // The Settings page is admin-only, so its data is too -- with one exception,
  // /ui-language below, which is not settings data so much as a property of the
  // whole dashboard: every user's I18nProvider reads it to render any page at
  // all. Gating that would leave non-admins stuck in English.
  app.get("/log-retention", async (req, reply) => {
    if (!requireAdmin(req, reply, ACTION_VIEW_SETTINGS)) return reply;
    return { days: Number(c.settings.get(LOG_RETENTION_DAYS_KEY) ?? 0) || 0 };
  });

  app.put("/log-retention", async (req, reply) => {
    if (!requireAdmin(req, reply, "change log retention")) return reply;
    const data = parseBody(RetentionPut, req, reply);
    if (!data) return reply;
    c.settings.set(LOG_RETENTION_DAYS_KEY, String(data.days));
    // Apply immediately so turning it on prunes the existing backlog now.
    let pruned = 0;
    if (data.days > 0) {
      try {
        pruned = c.pruner.pruneOlderThan(data.days);
      } catch {
        /* the setting is saved; the daily tick will retry */
      }
    }
    return { days: data.days, pruned };
  });

  // OCR image cache: the storage budget plus what it is currently using, so the
  // number the admin is setting can be compared against the number it bounds.
  app.get("/image-cache", async (req, reply) => {
    if (!requireAdmin(req, reply, ACTION_VIEW_SETTINGS)) return reply;
    return { maxBytes: c.settings.imageCacheMaxBytes(), ...c.imageCache.stats() };
  });

  app.put("/image-cache", async (req, reply) => {
    if (!requireAdmin(req, reply, "change the image cache budget")) return reply;
    const data = parseBody(ImageCachePut, req, reply);
    if (!data) return reply;
    c.settings.setImageCacheMaxBytes(data.maxBytes);
    // Apply immediately, exactly like log retention: lowering the budget has to
    // free the space now, not on the next request that happens to cache something.
    let evicted = 0;
    try {
      evicted = c.imageCache.enforceBudget(data.maxBytes);
    } catch {
      /* the setting is saved; the next put() enforces it */
    }
    return { maxBytes: data.maxBytes, evicted, ...c.imageCache.stats() };
  });

  app.delete("/image-cache", async (req, reply) => {
    if (!requireAdmin(req, reply, "clear the image cache")) return reply;
    const cleared = c.imageCache.clear();
    return { cleared, maxBytes: c.settings.imageCacheMaxBytes(), ...c.imageCache.stats() };
  });

  app.get("/upstream-allowlist", async (req, reply) => {
    if (!requireAdmin(req, reply, ACTION_VIEW_SETTINGS)) return reply;
    return { entries: c.settings.allowlist() };
  });

  app.put("/upstream-allowlist", async (req, reply) => {
    if (!requireAdmin(req, reply, "edit the upstream allowlist")) return reply;
    const data = parseBody(AllowlistPut, req, reply);
    if (!data) return reply;
    const entries = Array.from(new Set(data.entries.map((e) => e.trim()).filter(Boolean)));
    const bad = entries.filter((e) => !isValidAllowlistEntry(e));
    if (bad.length) return badRequest(reply, `invalid entries (use IP, v4 CIDR, or hostname): ${bad.join(", ")}`);
    c.settings.writeAllowlist(entries);
    return { entries };
  });

  // UI language (localization). Readable by any logged-in user; admin-only to change.
  app.get("/ui-language", async () => ({ language: c.settings.uiLanguage() }));

  app.put("/ui-language", async (req, reply) => {
    if (!requireAdmin(req, reply, "change the UI language")) return reply;
    const data = parseBody(UiLanguagePut, req, reply);
    if (!data) return reply;
    c.settings.setUiLanguage(data.language);
    return { language: data.language };
  });

  // The running server's release — the Settings page footer. Reported by the
  // server rather than baked into the web bundle so a stale cached bundle can
  // never claim a version the server isn't actually running.
  app.get("/version", async (req, reply) => {
    if (!requireAdmin(req, reply, ACTION_VIEW_SETTINGS)) return reply;
    return { version: APP_VERSION };
  });

  // Runtime-overridable env settings (the values the dashboard can change
  // without a restart). Boot-time env vars are the defaults; these persist on
  // top. Read-only for non-admins.
  app.get("/env", async (req, reply) => {
    if (!requireAdmin(req, reply, ACTION_VIEW_SETTINGS)) return reply;
    return {
      ...c.settings.runtimeEnv(),
      env: {
        // Boot-time-only values, surfaced read-only (changing needs a restart).
        nodeEnv: c.config.nodeEnv,
        port: c.config.port,
        host: c.config.host,
        dataDir: c.config.dataDir,
        adminUsername: c.config.admin.username,
        cookieSecure: c.config.cookieSecure,
        trustProxy: c.config.trustProxy,
      },
    };
  });

  app.put("/env", async (req, reply) => {
    if (!requireAdmin(req, reply, "change environment settings")) return reply;
    const p = parseBody(EnvSettingsPut, req, reply);
    if (!p) return reply;
    if (p.allowPrivateUpstreams !== undefined) c.settings.writeAllowPrivate(p.allowPrivateUpstreams);
    if (p.logPayloadMaxChars !== undefined) c.settings.setLogPayloadMaxChars(p.logPayloadMaxChars);
    if (p.simulatedStreamingTokenRate !== undefined) c.settings.setSimulatedStreamingTokenRate(p.simulatedStreamingTokenRate);
    if (p.sessionTtlMs !== undefined) c.settings.setSessionTtlMs(p.sessionTtlMs);
    if (p.promptCacheTtlMinutes !== undefined) c.settings.setPromptCacheTtlMinutes(p.promptCacheTtlMinutes);
    return { ...c.settings.runtimeEnv() };
  });
}
