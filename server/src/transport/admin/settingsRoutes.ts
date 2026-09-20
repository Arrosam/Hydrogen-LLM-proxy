import type { FastifyInstance } from "fastify";
import net from "node:net";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization";
import type { Container } from "../../composition/container";
import { parse } from "../../util/validate";
import { APP_VERSION } from "../../util/version";

// --- settings ---------------------------------------------------------------

function isValidAllowlistEntry(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.includes("/")) {
    const [base, bitsStr] = s.split("/");
    const bits = Number(bitsStr);
    return net.isIP(base) === 4 && Number.isInteger(bits) && bits >= 0 && bits <= 32;
  }
  if (net.isIP(s)) return true;
  const host = s.startsWith(".") ? s.slice(1) : s;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host);
}

const AllowlistPut = z.object({ entries: z.array(z.string()).max(200) });
const RetentionPut = z.object({ days: z.number().int().min(0).max(3650) });
const UiLanguagePut = z.object({ language: z.enum(["en", "zh"]) });
const EnvSettingsPut = z.object({
  allowPrivateUpstreams: z.boolean().optional(),
  logPayloadMaxChars: z.number().int().min(0).max(10_000_000).optional(),
  simulatedStreamingTokenRate: z.number().int().min(1).max(1_000_000).optional(),
  sessionTtlMs: z.number().int().min(60_000).max(30 * 86_400_000).optional(),
  promptCacheTtlMinutes: z.number().int().min(1).max(24 * 60).optional(),
});

/** 64 GiB — far past any sane cache, but a finite cap keeps a typo from being
 * read as "unbounded". 0 turns the cache off and empties it. */
const MAX_IMAGE_CACHE_BYTES = 64 * 1024 * 1024 * 1024;
const ImageCachePut = z.object({ maxBytes: z.number().int().min(0).max(MAX_IMAGE_CACHE_BYTES) });

export async function settingsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/response-retention", async (req, reply) => {
    if (!requireAdmin(req, reply, "view settings")) return;
    return { days: c.settings.responseRetentionDays() };
  });
  app.put("/response-retention", async (req, reply) => {
    if (!requireAdmin(req, reply, "change response retention")) return;
    const parsed = parse(RetentionPut, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const value = parsed.data;
    c.settings.set("response_retention_days", String(value.days));
    c.responses.prune();
    return value;
  });
  // The Settings page is admin-only, so its data is too -- with one exception,
  // /ui-language below, which is not settings data so much as a property of the
  // whole dashboard: every user's I18nProvider reads it to render any page at
  // all. Gating that would leave non-admins stuck in English.
  app.get("/log-retention", async (req, reply) => {
    if (!requireAdmin(req, reply, "view settings")) return reply;
    return { days: Number(c.settings.get("log_retention_days") ?? 0) || 0 };
  });

  app.put("/log-retention", async (req, reply) => {
    if (!requireAdmin(req, reply, "change log retention")) return reply;
    const parsed = parse(RetentionPut, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    c.settings.set("log_retention_days", String(parsed.data.days));
    // Apply immediately so turning it on prunes the existing backlog now.
    let pruned = 0;
    if (parsed.data.days > 0) {
      try {
        pruned = c.pruner.pruneOlderThan(parsed.data.days);
      } catch {
        /* the setting is saved; the daily tick will retry */
      }
    }
    return { days: parsed.data.days, pruned };
  });

  // OCR image cache: the storage budget plus what it is currently using, so the
  // number the admin is setting can be compared against the number it bounds.
  app.get("/image-cache", async (req, reply) => {
    if (!requireAdmin(req, reply, "view settings")) return reply;
    return { maxBytes: c.settings.imageCacheMaxBytes(), ...c.imageCache.stats() };
  });

  app.put("/image-cache", async (req, reply) => {
    if (!requireAdmin(req, reply, "change the image cache budget")) return reply;
    const parsed = parse(ImageCachePut, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    c.settings.setImageCacheMaxBytes(parsed.data.maxBytes);
    // Apply immediately, exactly like log retention: lowering the budget has to
    // free the space now, not on the next request that happens to cache something.
    let evicted = 0;
    try {
      evicted = c.imageCache.enforceBudget(parsed.data.maxBytes);
    } catch {
      /* the setting is saved; the next put() enforces it */
    }
    return { maxBytes: parsed.data.maxBytes, evicted, ...c.imageCache.stats() };
  });

  app.delete("/image-cache", async (req, reply) => {
    if (!requireAdmin(req, reply, "clear the image cache")) return reply;
    const cleared = c.imageCache.clear();
    return { cleared, maxBytes: c.settings.imageCacheMaxBytes(), ...c.imageCache.stats() };
  });

  app.get("/upstream-allowlist", async (req, reply) => {
    if (!requireAdmin(req, reply, "view settings")) return reply;
    return { entries: c.settings.allowlist() };
  });

  app.put("/upstream-allowlist", async (req, reply) => {
    if (!requireAdmin(req, reply, "edit the upstream allowlist")) return reply;
    const parsed = parse(AllowlistPut, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const entries = Array.from(new Set(parsed.data.entries.map((e) => e.trim()).filter(Boolean)));
    const bad = entries.filter((e) => !isValidAllowlistEntry(e));
    if (bad.length) return reply.code(400).send({ error: `invalid entries (use IP, v4 CIDR, or hostname): ${bad.join(", ")}` });
    c.settings.writeAllowlist(entries);
    return { entries };
  });

  // UI language (localization). Readable by any logged-in user; admin-only to change.
  app.get("/ui-language", async () => ({ language: c.settings.uiLanguage() }));

  app.put("/ui-language", async (req, reply) => {
    if (!requireAdmin(req, reply, "change the UI language")) return reply;
    const parsed = parse(UiLanguagePut, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    c.settings.setUiLanguage(parsed.data.language);
    return { language: parsed.data.language };
  });

  // The running server's release — the Settings page footer. Reported by the
  // server rather than baked into the web bundle so a stale cached bundle can
  // never claim a version the server isn't actually running.
  app.get("/version", async (req, reply) => {
    if (!requireAdmin(req, reply, "view settings")) return reply;
    return { version: APP_VERSION };
  });

  // Runtime-overridable env settings (the values the dashboard can change
  // without a restart). Boot-time env vars are the defaults; these persist on
  // top. Read-only for non-admins.
  app.get("/env", async (req, reply) => {
    if (!requireAdmin(req, reply, "view settings")) return reply;
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
    const parsed = parse(EnvSettingsPut, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const p = parsed.data;
    if (p.allowPrivateUpstreams !== undefined) c.settings.writeAllowPrivate(p.allowPrivateUpstreams);
    if (p.logPayloadMaxChars !== undefined) c.settings.setLogPayloadMaxChars(p.logPayloadMaxChars);
    if (p.simulatedStreamingTokenRate !== undefined) c.settings.setSimulatedStreamingTokenRate(p.simulatedStreamingTokenRate);
    if (p.sessionTtlMs !== undefined) c.settings.setSessionTtlMs(p.sessionTtlMs);
    if (p.promptCacheTtlMinutes !== undefined) c.settings.setPromptCacheTtlMinutes(p.promptCacheTtlMinutes);
    return { ...c.settings.runtimeEnv() };
  });
}
