import type { FastifyInstance } from "fastify";
import net from "node:net";
import { z, ZodError } from "zod";
import { idParam, parse } from "../util/validate";
import { asMillis } from "../util/time";
import type { Container } from "../composition/container";
import { requireSession } from "../auth/middleware";
import { cookieOptions, resolveCookieSecure, SESSION_COOKIE, signSession } from "../auth/session";
import { DEFAULT_ADMIN_PASSWORD } from "../db/bootstrap";
import { isAgent, summarizeService, type ServiceDef } from "../execution/definition";
import { ServiceValidationError } from "../execution/serviceValidator";
import { buildRequest } from "../core/format/registry";
import { textOf } from "../core/ir/content";
import { failureMessage } from "../core/proxy/errors";
import { buildHeaders, modelsUrl } from "../core/upstream/endpoints";
import { familyForProviderType } from "../core/format/family";
import { BLOCK_THRESHOLD_MS } from "../observability/activeRequests";
import type { ModelServiceRow } from "../db/schema";

/** Registered by the app under the /admin/api prefix. */
export async function adminRoutes(app: FastifyInstance, c: Container): Promise<void> {
  await app.register((scoped) => authRoutes(scoped, c));

  await app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(c.users));
    await scoped.register((s) => userRoutes(s, c), { prefix: "/users" });
    await scoped.register((s) => providerRoutes(s, c), { prefix: "/providers" });
    await scoped.register((s) => catalogRoutes(s, c));
    await scoped.register((s) => serviceRoutes(s, c), { prefix: "/services" });
    await scoped.register((s) => tokenRoutes(s, c), { prefix: "/tokens" });
    await scoped.register((s) => logRoutes(s, c));
    await scoped.register((s) => activeRequestRoutes(s, c));
    await scoped.register((s) => settingsRoutes(s, c), { prefix: "/settings" });
  });
}

// --- auth -------------------------------------------------------------------

const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const ChangePasswordSchema = z.object({
  newPassword: z.string().min(8, "new password must be at least 8 characters"),
  currentPassword: z.string().optional(),
});

async function authRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/setup-info", async () => {
    const hint = c.users.initialCredentialHint();
    return { initial: hint ? { username: hint.username, password: DEFAULT_ADMIN_PASSWORD } : null };
  });

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = parse(LoginSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const user = await c.users.verifyLogin(parsed.data.username, parsed.data.password);
    if (!user) return reply.code(401).send({ error: "invalid credentials" });
    const token = signSession({ uid: user.id, username: user.username, role: user.role });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(resolveCookieSecure(req.protocol === "https")));
    return { user: c.users.toPublic(user) };
  });

  app.post("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", { preHandler: requireSession(c.users) }, async (req, reply) => {
    const user = req.user ? c.users.get(req.user.uid) : undefined;
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { user: c.users.toPublic(user) };
  });

  app.post("/change-password", { preHandler: requireSession(c.users) }, async (req, reply) => {
    const parsed = parse(ChangePasswordSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const result = await c.users.changeOwnPassword(req.user!.uid, parsed.data.newPassword, parsed.data.currentPassword);
    if (result === "not_found") return reply.code(404).send({ error: "user not found" });
    if (result === "wrong_current") return reply.code(400).send({ error: "current password is incorrect" });
    const user = c.users.get(req.user!.uid);
    return { user: user ? c.users.toPublic(user) : null };
  });
}

// --- users ------------------------------------------------------------------

const RoleSchema = z.enum(["admin", "manager"]);
const UserCreate = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8, "password must be at least 8 characters"),
  role: RoleSchema.default("manager"),
  enabled: z.boolean().optional(),
});
const UserUpdate = z.object({ role: RoleSchema.optional(), enabled: z.boolean().optional(), password: z.string().min(8).optional() });

async function userRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ users: c.users.list().map((u) => c.users.toPublic(u)) }));

  app.post("/", async (req, reply) => {
    const parsed = parse(UserCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const actor = req.user!;
    if (parsed.data.role === "admin" && actor.role !== "admin") {
      return reply.code(403).send({ error: "only an admin can create admin users" });
    }
    if (c.users.getByUsername(parsed.data.username)) return reply.code(409).send({ error: "username already exists" });
    const user = await c.users.create(parsed.data);
    return reply.code(201).send({ user: c.users.toPublic(user) });
  });

  app.patch("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const target = c.users.get(id);
    if (!target) return reply.code(404).send({ error: "not found" });
    const parsed = parse(UserUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const actor = req.user!;
    if (actor.role !== "admin") {
      if (target.role === "admin") return reply.code(403).send({ error: "managers cannot modify admin users" });
      if (parsed.data.role === "admin") return reply.code(403).send({ error: "managers cannot promote users to admin" });
    }
    if (actor.uid === id && parsed.data.enabled === false) {
      return reply.code(400).send({ error: "you cannot deactivate your own account" });
    }
    if ((parsed.data.role === "manager" || parsed.data.enabled === false) && target.role === "admin") {
      const admins = c.users.list().filter((u) => u.role === "admin" && u.enabled);
      if (admins.length <= 1 && admins[0]?.id === id) {
        return reply.code(400).send({ error: "cannot deactivate or demote the last admin" });
      }
    }
    const user = await c.users.update(id, parsed.data);
    return { user: user ? c.users.toPublic(user) : null };
  });

  app.delete("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const target = c.users.get(id);
    if (!target) return reply.code(404).send({ error: "not found" });
    const actor = req.user!;
    if (actor.role !== "admin" && target.role === "admin") return reply.code(403).send({ error: "managers cannot delete admin users" });
    if (target.role === "admin") {
      const admins = c.users.list().filter((u) => u.role === "admin");
      if (admins.length <= 1) return reply.code(400).send({ error: "cannot delete the last admin" });
    }
    if (actor.uid === id) return reply.code(400).send({ error: "cannot delete your own account" });
    c.users.delete(id);
    return { ok: true };
  });
}

// --- providers --------------------------------------------------------------

const TypeSchema = z.enum(["openai_completion", "openai_responses", "anthropic"]);
const HeadersSchema = z.record(z.string(), z.string()).nullable().optional();
const BaseUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:$/.test(new URL(u).protocol), { message: "baseUrl must use http or https" });

const ProviderCreate = z.object({
  name: z.string().min(1).max(120),
  type: TypeSchema,
  baseUrl: BaseUrlSchema,
  apiKey: z.string().nullable().optional(),
  extraHeaders: HeadersSchema,
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});
const ProviderUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  type: TypeSchema.optional(),
  baseUrl: BaseUrlSchema.optional(),
  apiKey: z.string().nullable().optional(),
  extraHeaders: HeadersSchema,
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});

async function providerRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ providers: c.providers.list().map((p) => c.providers.toPublic(p)) }));

  app.post("/", async (req, reply) => {
    const parsed = parse(ProviderCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return reply.code(201).send({ provider: c.providers.toPublic(c.providers.create(parsed.data)) });
  });

  app.patch("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.providers.get(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(ProviderUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const provider = c.providers.update(id, parsed.data);
    return { provider: provider ? c.providers.toPublic(provider) : null };
  });

  app.delete("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.providers.get(id)) return reply.code(404).send({ error: "not found" });
    c.providers.delete(id);
    return { ok: true };
  });

  app.post("/:id/test", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const provider = c.providers.get(id);
    if (!provider) return reply.code(404).send({ error: "not found" });
    const up = c.providers.toUpstream(provider);
    try {
      const res = await c.transport.getJson(modelsUrl(up), buildHeaders(up), { timeoutMs: 15_000 });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, message: "Connection OK" };
      const family = familyForProviderType(provider.type);
      const text = (res.text ?? "").trim();
      const short = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      return { ok: false, status: res.status, message: `Upstream returned ${res.status} for the ${family} models endpoint. ${short}` };
    } catch (e) {
      return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
    }
  });
}

// --- catalog (models + mappings) --------------------------------------------

const ModelCreate = z.object({ name: z.string().min(1).max(120), description: z.string().nullable().optional(), enabled: z.boolean().optional() });
const ModelUpdate = ModelCreate.partial();
const MappingCreate = z.object({
  modelId: z.number().int().positive(),
  providerId: z.number().int().positive(),
  upstreamModel: z.string().min(1),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});
const MappingUpdate = z.object({ upstreamModel: z.string().min(1).optional(), priority: z.number().int().optional(), enabled: z.boolean().optional() });

async function catalogRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/models", async () => ({ models: c.models.list() }));
  app.post("/models", async (req, reply) => {
    const parsed = parse(ModelCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return reply.code(201).send({ model: c.models.create(parsed.data) });
  });
  app.patch("/models/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.models.get(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(ModelUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return { model: c.models.update(id, parsed.data) };
  });
  app.delete("/models/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.models.get(id)) return reply.code(404).send({ error: "not found" });
    c.models.delete(id);
    return { ok: true };
  });

  app.get("/mappings", async () => ({ mappings: c.mappings.list() }));
  app.post("/mappings", async (req, reply) => {
    const parsed = parse(MappingCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { modelId, providerId } = parsed.data;
    if (!c.models.get(modelId)) return reply.code(400).send({ error: "model not found" });
    if (!c.providers.get(providerId)) return reply.code(400).send({ error: "provider not found" });
    if (c.mappings.listForModel(modelId).some((m) => m.providerId === providerId)) {
      return reply.code(409).send({ error: "this model is already mapped to that provider" });
    }
    return reply.code(201).send({ mapping: c.mappings.create(parsed.data) });
  });
  app.patch("/mappings/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const parsed = parse(MappingUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const mapping = c.mappings.update(id, parsed.data);
    if (!mapping) return reply.code(404).send({ error: "not found" });
    return { mapping };
  });
  app.delete("/mappings/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    c.mappings.delete(id);
    return { ok: true };
  });
}

// --- services ---------------------------------------------------------------

const ServiceCreate = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  steps: z.unknown(),
  enabled: z.boolean().optional(),
});
const ServiceUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().nullable().optional(),
  steps: z.unknown().optional(),
  enabled: z.boolean().optional(),
});

function presentService(c: Container, m: ModelServiceRow): Record<string, unknown> {
  let summary = "";
  try {
    summary = summarizeService(c.services.def(m));
  } catch {
    summary = "(invalid steps)";
  }
  return { id: m.id, name: m.name, description: m.description, steps: m.definition, enabled: m.enabled, summary, createdAt: asMillis(m.createdAt) };
}

function serviceValidationError(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (e instanceof ServiceValidationError) return { status: 400, body: { error: e.message, invalidPairs: e.invalidPairs } };
  if (e instanceof ZodError) {
    const msg = e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { status: 400, body: { error: `invalid steps: ${msg}` } };
  }
  return null;
}

async function serviceRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ services: c.services.list().map((m) => presentService(c, m)) }));

  app.post("/validate", async (req, reply) => {
    const body = (req.body ?? {}) as { steps?: unknown };
    try {
      const { def, summary } = c.validator.validate(body.steps);
      const kind = isAgent(def) ? "agent" : "resilience";
      const count = isAgent(def) ? def.stages.length : def.steps.length;
      return { valid: true, summary, kind, count };
    } catch (e) {
      const mapped = serviceValidationError(e);
      if (mapped) return reply.code(200).send({ valid: false, ...mapped.body });
      throw e;
    }
  });

  app.post("/", async (req, reply) => {
    const parsed = parse(ServiceCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      const { def } = c.validator.validate(parsed.data.steps);
      const row = c.services.create({ name: parsed.data.name, description: parsed.data.description, definition: def, enabled: parsed.data.enabled });
      return reply.code(201).send({ service: presentService(c, row) });
    } catch (e) {
      const mapped = serviceValidationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }
  });

  app.patch("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.services.get(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(ServiceUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      const patch: { name?: string; description?: string | null; definition?: ServiceDef; enabled?: boolean } = {
        name: parsed.data.name,
        description: parsed.data.description,
        enabled: parsed.data.enabled,
      };
      if (parsed.data.steps !== undefined) patch.definition = c.validator.validate(parsed.data.steps).def;
      const row = c.services.update(id, patch);
      return { service: row ? presentService(c, row) : null };
    } catch (e) {
      const mapped = serviceValidationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }
  });

  app.delete("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.services.get(id)) return reply.code(404).send({ error: "not found" });
    c.services.delete(id);
    return { ok: true };
  });

  // Dry-run: fire a small request through a service (saved id or ad-hoc steps).
  app.post("/test", async (req, reply) => {
    const body = (req.body ?? {}) as { serviceId?: number; steps?: unknown; prompt?: string };
    let def: ServiceDef;
    try {
      if (body.serviceId) {
        const row = c.services.get(body.serviceId);
        if (!row) return reply.code(404).send({ error: "Model Service not found" });
        def = c.services.def(row);
      } else {
        def = c.validator.validate(body.steps).def;
      }
    } catch (e) {
      const mapped = serviceValidationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }

    const { executor } = c.factory.buildDef(def);
    const request = buildRequest("openai_completion", {
      requestedService: "(dry-run)",
      messages: [{ role: "user", content: [{ type: "text", text: body.prompt || "ping" }] }],
      params: { maxTokens: isAgent(def) ? 64 : 16 },
      stream: false,
    });
    const outcome = await executor.invoke(request);
    if (outcome.result.ok) {
      const v = outcome.result.value;
      return { ok: true, attemptPath: outcome.attemptPath, served: { model: v.modelName, provider: v.providerName }, output: textOf(v.response.content).slice(0, 500) };
    }
    return { ok: false, status: outcome.result.status, message: failureMessage(outcome.result), attemptPath: outcome.attemptPath };
  });
}

// --- tokens -----------------------------------------------------------------

const TokenCreate = z.object({
  name: z.string().min(1).max(120),
  scopeServices: z.array(z.number().int().positive()).nullable().optional(),
  maxRequests: z.number().int().positive().nullable().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});
const TokenUpdate = TokenCreate.partial();

async function tokenRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ tokens: c.tokens.list().map((t) => c.tokens.toPublic(t)) }));

  app.post("/", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can issue tokens" });
    const parsed = parse(TokenCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { token, secret } = c.tokens.create({ ...parsed.data, ownerUserId: req.user.uid });
    return reply.code(201).send({ token: c.tokens.toPublic(token), secret });
  });

  app.patch("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.tokens.get(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(TokenUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const token = c.tokens.update(id, parsed.data);
    return { token: token ? c.tokens.toPublic(token) : null };
  });

  app.delete("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.tokens.get(id)) return reply.code(404).send({ error: "not found" });
    c.tokens.delete(id);
    return { ok: true };
  });
}

// --- logs + stats -----------------------------------------------------------

function numParam(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function boolParam(v: unknown): boolean | undefined {
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

async function logRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/logs", async (req) => {
    const q = req.query as Record<string, string>;
    return c.logs.query({
      tokenId: numParam(q.tokenId),
      serviceId: numParam(q.serviceId),
      status: numParam(q.status),
      errorsOnly: boolParam(q.errorsOnly),
      from: numParam(q.from),
      to: numParam(q.to),
      limit: numParam(q.limit),
      offset: numParam(q.offset),
    });
  });

  app.get("/logs/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const log = c.logs.get(id);
    if (!log) return reply.code(404).send({ error: "not found" });
    return { log };
  });

  // Clear the entire request log (and reclaim the file space).
  app.delete("/logs", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can clear logs" });
    const deleted = c.logs.deleteAll();
    try {
      c.sqlite.exec("VACUUM");
    } catch {
      /* best-effort space reclaim; the rows are already gone */
    }
    return { deleted };
  });

  const range = (req: { query: unknown }): { from?: number; to?: number } => {
    const q = req.query as Record<string, string>;
    return { from: numParam(q.from), to: numParam(q.to) };
  };
  app.get("/stats/summary", async (req) => c.stats.summary(range(req)));
  app.get("/stats/timeseries", async (req) => ({ points: c.stats.timeSeries(range(req)) }));
  app.get("/stats/by-service", async (req) => ({ groups: c.stats.byService(range(req)) }));
  app.get("/stats/by-model-provider", async (req) => c.stats.byModelProvider(range(req)));
}

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
});

async function settingsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  // Log retention: keep only the most recent N days of request logs (0 = keep forever).
  app.get("/log-retention", async () => ({ days: Number(c.settings.get("log_retention_days") ?? 0) || 0 }));

  app.put("/log-retention", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can change log retention" });
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

  app.get("/upstream-allowlist", async () => ({ entries: c.settings.allowlist() }));

  app.put("/upstream-allowlist", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can edit the upstream allowlist" });
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
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can change the UI language" });
    const parsed = parse(UiLanguagePut, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    c.settings.setUiLanguage(parsed.data.language);
    return { language: parsed.data.language };
  });

  // Runtime-overridable env settings (the values the dashboard can change
  // without a restart). Boot-time env vars are the defaults; these persist on
  // top. Read-only for non-admins.
  app.get("/env", async () => ({
    ...c.settings.runtimeEnv(),
    env: {
      // Boot-time-only values, surfaced read-only (changing needs a restart).
      nodeEnv: c.config.nodeEnv,
      port: c.config.port,
      host: c.config.host,
      dataDir: c.config.dataDir,
      adminUsername: c.config.admin.username,
      cookieSecure: c.config.cookieSecure,
    },
  }));

  app.put("/env", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can change environment settings" });
    const parsed = parse(EnvSettingsPut, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const p = parsed.data;
    if (p.allowPrivateUpstreams !== undefined) c.settings.writeAllowPrivate(p.allowPrivateUpstreams);
    if (p.logPayloadMaxChars !== undefined) c.settings.setLogPayloadMaxChars(p.logPayloadMaxChars);
    if (p.simulatedStreamingTokenRate !== undefined) c.settings.setSimulatedStreamingTokenRate(p.simulatedStreamingTokenRate);
    if (p.sessionTtlMs !== undefined) c.settings.setSessionTtlMs(p.sessionTtlMs);
    return { ...c.settings.runtimeEnv() };
  });
}

// --- active requests (real-time monitoring) ----------------------------------

/** Serialize an ActiveRequest for the API (with computed fields for the UI). */
function serializeActive(r: import("../observability/activeRequests").ActiveRequest, now: number) {
  const elapsedMs = now - r.startedAt;
  const lastEvent = r.events.length > 0 ? r.events[r.events.length - 1] : null;
  return {
    traceId: r.traceId,
    tokenId: r.tokenId,
    serviceId: r.serviceId,
    serviceName: r.serviceName,
    ingress: r.ingress,
    streaming: r.streaming,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    elapsedMs,
    blocked: !r.done && elapsedMs > BLOCK_THRESHOLD_MS,
    done: r.done,
    httpStatus: r.httpStatus,
    error: r.error,
    eventCount: r.events.length,
    lastPhase: lastEvent?.phase ?? null,
    lastNode: lastEvent?.node ?? null,
    lastMessage: lastEvent?.message ?? null,
    lastEventTs: lastEvent?.ts ?? null,
    events: r.events,
  };
}

async function activeRequestRoutes(app: FastifyInstance, c: Container): Promise<void> {
  // List all in-flight requests + recently completed (for the real-time panel).
  app.get("/active-requests", async (req) => {
    const q = req.query as Record<string, string>;
    const now = Date.now();
    const active = c.activeRequests.listActive().map((r) => serializeActive(r, now));
    // Include recently completed (limit 20) so the UI can show what just finished.
    const completed = c.activeRequests.listCompleted(20).map((r) => serializeActive(r, now));

    // Optional filter by traceId (for single-request tracing).
    const traceFilter = q.traceId;
    if (traceFilter) {
      return {
        active: active.filter((r) => r.traceId === traceFilter),
        completed: completed.filter((r) => r.traceId === traceFilter),
        blockThresholdMs: BLOCK_THRESHOLD_MS,
        now,
      };
    }

    // Sort: blocked first, then by elapsed descending (longest running on top).
    active.sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
      return b.elapsedMs - a.elapsedMs;
    });

    return { active, completed, blockThresholdMs: BLOCK_THRESHOLD_MS, now };
  });

  // Get a single request by traceId (active or completed) with full event stream.
  app.get("/active-requests/:traceId", async (req, reply) => {
    const traceId = (req.params as { traceId?: string }).traceId;
    if (!traceId) return reply.code(400).send({ error: "missing traceId" });
    const r = c.activeRequests.get(traceId);
    if (!r) return reply.code(404).send({ error: "trace not found (may have expired from the ring buffer)" });
    return { request: serializeActive(r, Date.now()), blockThresholdMs: BLOCK_THRESHOLD_MS };
  });

  // Summary stats (counters for the dashboard).
  app.get("/active-requests/stats", async () => {
    const s = c.activeRequests.stats();
    const now = Date.now();
    const active = c.activeRequests.listActive();
    const blocked = active.filter((r) => now - r.startedAt > BLOCK_THRESHOLD_MS).length;
    return { ...s, blocked, blockThresholdMs: BLOCK_THRESHOLD_MS, now };
  });
}
