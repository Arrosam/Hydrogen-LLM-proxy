import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import net from "node:net";
import { z, ZodError } from "zod";
import { idParam, parse } from "../util/validate";
import { asMillis } from "../util/time";
import type { Container } from "../composition/container";
import { requireSession } from "../auth/middleware";
import { cookieOptions, resolveCookieSecure, SESSION_COOKIE, signSession, type SessionPayload } from "../auth/session";
import { DEFAULT_ADMIN_PASSWORD } from "../db/bootstrap";
import { AgentOcrSchema, isAgent, isChatPipeline, serviceCategory, summarizeService, type AgentOcr, type ServiceDef } from "../execution/definition";
import { ServiceValidationError } from "../execution/serviceValidator";
import { buildOcrRequest, parseOcrResults } from "../execution/agentContext";
import type { ModelService } from "../execution/modelService";
import { buildRequest } from "../core/format/registry";
import { textOf, type ImagePart } from "../core/ir/content";
import { failureMessage } from "../core/proxy/errors";
import { discoverModels, MAX_DISCOVERED_MODELS, MAX_MODEL_ID_LENGTH } from "../catalog/modelDiscovery";
import { BLOCK_THRESHOLD_MS } from "../observability/activeRequests";
import { withJsonHeartbeat } from "./jsonKeepalive";
import { BackupError, exportBackup, restoreBackup } from "../backup/archive";
import { PassphraseError } from "../security/passphrase";
import { APP_VERSION } from "../util/version";
import type { ModelServiceRow } from "../db/schema";

/** Registered by the app under the /admin/api prefix. */
export async function adminRoutes(app: FastifyInstance, c: Container): Promise<void> {
  // One guard instance, shared by every authenticated route. Built once here so
  // the session-epoch floor cannot be wired into some routes and forgotten in
  // others (a forgotten one would silently skip post-restore invalidation).
  const sessionGuard = requireSession(c.users, () => c.settings.sessionEpochMs());

  await app.register((scoped) => authRoutes(scoped, c, sessionGuard));
  await app.register((scoped) => checkRoutes(scoped, c));

  await app.register(async (scoped) => {
    scoped.addHook("preHandler", sessionGuard);
    await scoped.register((s) => userRoutes(s, c), { prefix: "/users" });
    await scoped.register((s) => providerRoutes(s, c), { prefix: "/providers" });
    await scoped.register((s) => catalogRoutes(s, c));
    await scoped.register((s) => serviceRoutes(s, c), { prefix: "/services" });
    await scoped.register((s) => tokenRoutes(s, c), { prefix: "/tokens" });
    await scoped.register((s) => logRoutes(s, c));
    await scoped.register((s) => activeRequestRoutes(s, c));
    await scoped.register((s) => settingsRoutes(s, c), { prefix: "/settings" });
    await scoped.register((s) => backupRoutes(s, c), { prefix: "/backup" });
    await scoped.register((s) => updateRoutes(s, c), { prefix: "/update" });
  });
}

/** 403 unless the caller is an admin. `action` completes "only an admin can ...".
 * A type guard, so a route can use `req.user` after it without a non-null cast. */
function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  action: string,
): req is FastifyRequest & { user: SessionPayload } {
  if (req.user?.role === "admin") return true;
  void reply.code(403).send({ error: `only an admin can ${action}` });
  return false;
}

// --- auth -------------------------------------------------------------------

const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const ChangePasswordSchema = z.object({
  newPassword: z.string().min(8, "new password must be at least 8 characters"),
  currentPassword: z.string().optional(),
});

async function authRoutes(app: FastifyInstance, c: Container, sessionGuard: ReturnType<typeof requireSession>): Promise<void> {
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

  app.get("/me", { preHandler: sessionGuard }, async (req, reply) => {
    const user = req.user ? c.users.get(req.user.uid) : undefined;
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { user: c.users.toPublic(user) };
  });

  app.post("/change-password", { preHandler: sessionGuard }, async (req, reply) => {
    const parsed = parse(ChangePasswordSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const result = await c.users.changeOwnPassword(req.user!.uid, parsed.data.newPassword, parsed.data.currentPassword);
    if (result === "not_found") return reply.code(404).send({ error: "user not found" });
    if (result === "wrong_current") return reply.code(400).send({ error: "current password is incorrect" });
    const user = c.users.get(req.user!.uid);
    return { user: user ? c.users.toPublic(user) : null };
  });
}

// --- check (public, API-key-authenticated) ----------------------------------

const CheckSchema = z.object({ apiKey: z.string().min(1) });

/** Public endpoint: given an API key, return its live status without requiring
 * a dashboard session. The key is authenticated the same way a proxy request
 * would be, so expired/disabled/quota-exceeded keys are reported honestly. */
async function checkRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.post("/check", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = parse(CheckSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const token = c.tokens.authenticate(parsed.data.apiKey);
    if (!token || !token.enabled) return reply.code(401).send({ error: "invalid or disabled API key" });
    const now = Date.now();
    const expiresAt = token.expiresAt instanceof Date ? token.expiresAt.getTime() : token.expiresAt;
    const expired = expiresAt != null && expiresAt < now;
    const requestsExceeded = token.maxRequests != null && token.usedRequests >= token.maxRequests;
    const tokensExceeded = token.maxTokens != null && token.usedTokens >= token.maxTokens;
    return {
      key: c.tokens.toPublic(token),
      status: {
        valid: !expired && !requestsExceeded && !tokensExceeded,
        expired,
        requestsExceeded,
        tokensExceeded,
        checkedAt: now,
      },
    };
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

/** User management is admin-only in its entirety: managers cannot even list
 * accounts. (A manager still changes their own password via /auth.) */
async function userRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async (req, reply) => {
    if (!requireAdmin(req, reply, "view users")) return reply;
    return { users: c.users.list().map((u) => c.users.toPublic(u)) };
  });

  app.post("/", async (req, reply) => {
    if (!requireAdmin(req, reply, "create users")) return reply;
    const parsed = parse(UserCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (c.users.getByUsername(parsed.data.username)) return reply.code(409).send({ error: "username already exists" });
    const user = await c.users.create(parsed.data);
    return reply.code(201).send({ user: c.users.toPublic(user) });
  });

  app.patch("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "modify users")) return reply;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const target = c.users.get(id);
    if (!target) return reply.code(404).send({ error: "not found" });
    const parsed = parse(UserUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (req.user.uid === id && parsed.data.enabled === false) {
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
    if (!requireAdmin(req, reply, "delete users")) return reply;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const target = c.users.get(id);
    if (!target) return reply.code(404).send({ error: "not found" });
    if (target.role === "admin") {
      const admins = c.users.list().filter((u) => u.role === "admin");
      if (admins.length <= 1) return reply.code(400).send({ error: "cannot delete the last admin" });
    }
    if (req.user.uid === id) return reply.code(400).send({ error: "cannot delete your own account" });
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

/** The model list captured from a provider test, persisted alongside the save.
 * Omitted = leave whatever is stored alone; `[]` = the provider reported none. */
const AvailableModelsSchema = z
  .array(z.string().min(1).max(MAX_MODEL_ID_LENGTH))
  .max(MAX_DISCOVERED_MODELS)
  .optional();

const ProviderCreate = z.object({
  name: z.string().min(1).max(120),
  type: TypeSchema,
  baseUrl: BaseUrlSchema,
  apiKey: z.string().nullable().optional(),
  extraHeaders: HeadersSchema,
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  availableModels: AvailableModelsSchema,
});
const ProviderUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  type: TypeSchema.optional(),
  baseUrl: BaseUrlSchema.optional(),
  apiKey: z.string().nullable().optional(),
  extraHeaders: HeadersSchema,
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  availableModels: AvailableModelsSchema,
});

/**
 * A provider test runs against the form in front of the user, not against what
 * is stored — that is the whole point of testing before saving. `id` is only
 * consulted to reuse the saved key when the key field was left blank (the
 * dashboard never sends a key it doesn't have the plaintext for).
 */
const ProviderTest = z.object({
  id: z.number().int().positive().optional(),
  type: TypeSchema,
  baseUrl: BaseUrlSchema,
  apiKey: z.string().nullable().optional(),
  extraHeaders: HeadersSchema,
});

async function providerRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ providers: c.providers.list().map((p) => c.providers.toPublic(p)) }));

  app.post("/", async (req, reply) => {
    const parsed = parse(ProviderCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { availableModels, ...input } = parsed.data;
    const provider = c.providers.create(input);
    if (availableModels) c.providerModels.replaceForProvider(provider.id, availableModels);
    return reply.code(201).send({ provider: c.providers.toPublic(provider) });
  });

  app.patch("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.providers.get(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(ProviderUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { availableModels, ...input } = parsed.data;
    const provider = c.providers.update(id, input);
    if (availableModels) c.providerModels.replaceForProvider(id, availableModels);
    return { provider: provider ? c.providers.toPublic(provider) : null };
  });

  app.delete("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.providers.get(id)) return reply.code(404).send({ error: "not found" });
    c.providers.delete(id);
    return { ok: true };
  });

  /** Reach the provider's models endpoint and report what it serves. Read-only:
   * the list is stored when the provider itself is saved, not here, so a test
   * on a form the user then abandons changes nothing. */
  app.post("/test", async (req, reply) => {
    const parsed = parse(ProviderTest, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { id, type, baseUrl, apiKey, extraHeaders } = parsed.data;
    let key = apiKey ?? null;
    if (apiKey === undefined && id !== undefined) {
      const stored = c.providers.get(id);
      if (!stored) return reply.code(404).send({ error: "not found" });
      key = c.providers.toUpstream(stored).apiKey;
    }
    return discoverModels(c.transport, { type, baseUrl, apiKey: key, extraHeaders: extraHeaders ?? null });
  });

  /** The stored list for one provider. */
  app.get("/:id/available-models", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.providers.get(id)) return reply.code(404).send({ error: "not found" });
    return c.providerModels.forProvider(id);
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

  /** Every provider's discovered model list, for the mapping picker. Providers
   * are few, so one call beats a request per provider. */
  app.get("/provider-models", async () => ({ providerModels: c.providerModels.grouped() }));

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

const OcrTestSchema = z.object({
  ocr: z.unknown(),
  image: z.object({
    mediaType: z.string().regex(/^image\//, "mediaType must be an image/* MIME type"),
    data: z.string().min(1, "image data (base64) is required"),
  }),
});

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

    // The dry-run fires a chat request; media categories speak other shapes.
    if (!isChatPipeline(serviceCategory(def))) {
      return reply.code(400).send({ error: `dry-run supports chat-pipeline services only (this is a ${serviceCategory(def)} service)` });
    }

    const { executor } = c.factory.buildDef(def);
    const request = buildRequest("openai_completion", {
      requestedService: "(dry-run)",
      messages: [{ role: "user", content: [{ type: "text", text: body.prompt || "ping" }] }],
      params: { maxTokens: isAgent(def) ? 64 : 16 },
      stream: false,
    });
    // A dry-run against a slow chain can outlive intermediary idle timeouts
    // (Cloudflare 524s a silent origin at ~100s); heartbeat while it runs.
    // Failures already travel in-body ({ok:false}), so committing 200 early
    // changes nothing semantically.
    return withJsonHeartbeat(reply, c.config.jsonCommitGraceMs, 10_000, async () => {
      const outcome = await executor.invoke(request);
      if (outcome.result.ok) {
        const v = outcome.result.value;
        return { ok: true, attemptPath: outcome.attemptPath, served: { model: v.modelName, provider: v.providerName }, output: textOf(v.response.content).slice(0, 500) };
      }
      return { ok: false, status: outcome.result.status, message: failureMessage(outcome.result), attemptPath: outcome.attemptPath };
    });
  });

  // Dry-run the OCR pre-pass: send one test image through an OCR config and
  // return what the model actually said. The config comes from the editor
  // (possibly unsaved). The image cache is bypassed by construction -- the OCR
  // service is invoked directly, so the test always measures the model.
  app.post("/test-ocr", async (req, reply) => {
    const parsed = parse(OcrTestSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    let ocr: AgentOcr;
    try {
      ocr = AgentOcrSchema.parse(parsed.data.ocr);
    } catch (e) {
      const mapped = serviceValidationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }

    // Resolve the OCR model exactly the way the Micro Agent pre-pass does.
    let executor: ModelService;
    if (ocr.service) {
      const r = c.factory.resolve(ocr.service);
      if (!r.ok) return reply.code(400).send({ error: r.message });
      if (r.isAgent) return reply.code(400).send({ error: `OCR reference "${ocr.service}" must be a Model Service, not a Micro Agent` });
      executor = r.executor;
    } else if (ocr.steps && ocr.steps.length) {
      try {
        const { def } = c.validator.validate({ timeoutMs: ocr.timeoutMs ?? 60_000, steps: ocr.steps });
        executor = c.factory.buildDef(def).executor;
      } catch (e) {
        const mapped = serviceValidationError(e);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw e;
      }
    } else {
      return reply.code(400).send({ error: "image translation (OCR) is enabled but has no model configured" });
    }

    const image: ImagePart = {
      type: "image",
      source: { kind: "base64", mediaType: parsed.data.image.mediaType, data: parsed.data.image.data },
    };
    const parent = buildRequest("openai_completion", {
      requestedService: "(ocr-test)",
      messages: [{ role: "user", content: [image] }],
      params: {},
      stream: false,
    });
    const ocrReq = buildOcrRequest(parent, [image], ocr);

    // OCR models routinely take 60-180s per attempt; without bytes on the
    // wire, Cloudflare answers the panel with a 524 at ~100s while the test
    // keeps running. Heartbeat until the outcome arrives — failures already
    // travel in-body ({ok:false}), so the early 200 commit costs nothing.
    return withJsonHeartbeat(reply, c.config.jsonCommitGraceMs, 10_000, async () => {
      const started = Date.now();
      const outcome = await executor.invoke(ocrReq, undefined, ocr.timeoutMs ? { timeoutMs: ocr.timeoutMs } : {});
      const latencyMs = Date.now() - started;
      if (outcome.result.ok) {
        const v = outcome.result.value;
        const raw = v.response.text();
        // Index 1 of the OCR output contract; empty when the model ignored it.
        const [description] = parseOcrResults(raw, 1);
        return {
          ok: true,
          served: { model: v.modelName, provider: v.providerName },
          latencyMs,
          usage: v.response.usage,
          description,
          raw: raw.slice(0, 20_000),
          attemptPath: outcome.attemptPath,
        };
      }
      return { ok: false, status: outcome.result.status, message: failureMessage(outcome.result), latencyMs, attemptPath: outcome.attemptPath };
    });
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
    if (!requireAdmin(req, reply, "issue API keys")) return reply;
    const parsed = parse(TokenCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { token, secret } = c.tokens.create({ ...parsed.data, ownerUserId: req.user.uid });
    return reply.code(201).send({ token: c.tokens.toPublic(token), secret });
  });

  // Re-reveal an issued key. Admin-gated like issuing; tokens from before the
  // secret was stored (hash-only) have nothing to reveal.
  app.get("/:id/secret", async (req, reply) => {
    if (!requireAdmin(req, reply, "reveal API keys")) return reply;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.tokens.get(id)) return reply.code(404).send({ error: "not found" });
    const secret = c.tokens.revealSecret(id);
    if (secret == null) return reply.code(409).send({ error: "key issued before stored keys; revoke and reissue to make it copyable" });
    return { secret };
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
    if (!requireAdmin(req, reply, "clear logs")) return reply;
    const deleted = c.logs.deleteAll();
    c.statsCache.reset();
    try {
      c.sqlite.exec("VACUUM");
    } catch {
      /* best-effort space reclaim; the rows are already gone */
    }
    return { deleted };
  });

  // The unbounded queries the dashboard actually issues come straight from the
  // in-memory StatsCache -- no SQL per view. An explicit from/to still runs the
  // SQL aggregation, since the cache only accumulates all-time totals.
  const range = (req: { query: unknown }): { from?: number; to?: number } => {
    const q = req.query as Record<string, string>;
    return { from: numParam(q.from), to: numParam(q.to) };
  };
  const bounded = (r: { from?: number; to?: number }): boolean => r.from != null || r.to != null;
  app.get("/stats/summary", async (req) => {
    const r = range(req);
    return bounded(r) ? c.stats.summary(r) : c.statsCache.summary();
  });
  app.get("/stats/timeseries", async (req) => {
    const r = range(req);
    return { points: bounded(r) ? c.stats.timeSeries(r) : c.statsCache.timeSeries() };
  });
  app.get("/stats/by-service", async (req) => {
    const r = range(req);
    return { groups: bounded(r) ? c.stats.byService(r) : c.statsCache.byService() };
  });
  app.get("/stats/by-model-provider", async (req) => {
    const r = range(req);
    return bounded(r) ? c.stats.byModelProvider(r) : c.statsCache.byModelProvider();
  });
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

/** 64 GiB — far past any sane cache, but a finite cap keeps a typo from being
 * read as "unbounded". 0 turns the cache off and empties it. */
const MAX_IMAGE_CACHE_BYTES = 64 * 1024 * 1024 * 1024;
const ImageCachePut = z.object({ maxBytes: z.number().int().min(0).max(MAX_IMAGE_CACHE_BYTES) });

async function settingsRoutes(app: FastifyInstance, c: Container): Promise<void> {
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
    return { ...c.settings.runtimeEnv() };
  });
}

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

async function backupRoutes(app: FastifyInstance, c: Container): Promise<void> {
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
    const parsed = parse(BackupRestore, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    let report;
    try {
      report = await restoreBackup(c.sqlite, c.config.masterKey, parsed.data.backup, parsed.data.passphrase);
    } catch (e) {
      // A bad passphrase or a malformed package is the caller's mistake, not a
      // server fault: 400 with the reason, and the database is untouched.
      if (e instanceof PassphraseError || e instanceof BackupError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
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

// --- updates ------------------------------------------------------------------

async function updateRoutes(app: FastifyInstance, c: Container): Promise<void> {
  // Latest-release status. Cached server-side; ?refresh=1 forces a refetch
  // (the "Check now" button), still admin-gated so the GitHub rate budget
  // cannot be drained through this proxy by ordinary users.
  app.get("/check", async (req, reply) => {
    if (!requireAdmin(req, reply, "check for updates")) return reply;
    const refresh = (req.query as Record<string, string>).refresh === "1";
    return c.updates.check(refresh);
  });

  // Restart-to-upgrade: reply, then shut down cleanly and let the supervisor
  // start the replacement. The endpoint is disabled unless the operator has
  // explicitly asserted that the deployment supervisor can do that safely.
  app.post("/restart", async (req, reply) => {
    if (!requireAdmin(req, reply, "restart the server")) return reply;
    if (!c.updates.restartSupported) {
      return reply.code(409).send({
        error: "remote restart is disabled for this deployment; update and restart it through its supervisor",
      });
    }
    req.log.warn({ user: req.user.username }, "restart-to-upgrade requested from the settings page");
    c.updates.scheduleRestart();
    return { restarting: true };
  });
}
