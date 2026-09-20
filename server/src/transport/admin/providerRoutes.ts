import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization";
import { discoverModels, MAX_DISCOVERED_MODELS, MAX_MODEL_ID_LENGTH } from "../../catalog/modelDiscovery";
import type { Container } from "../../composition/container";
import { FAMILIES } from "../../core/ir/params";
import { idParam, parse } from "../../util/validate";

// --- providers --------------------------------------------------------------

const TypeSchema = z.enum(FAMILIES);
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

const AltEndpointsSchema = z.array(z.object({ type: TypeSchema, baseUrl: BaseUrlSchema })).max(4).nullable().optional();
const ProviderCreate = z.object({
  name: z.string().min(1).max(120),
  type: TypeSchema,
  baseUrl: BaseUrlSchema,
  altEndpoints: AltEndpointsSchema,
  apiKey: z.string().nullable().optional(),
  extraHeaders: HeadersSchema,
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  /** Route this provider's upstream traffic through a saved proxy. null = direct. */
  proxyId: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  availableModels: AvailableModelsSchema,
});
const ProviderUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  type: TypeSchema.optional(),
  baseUrl: BaseUrlSchema.optional(),
  altEndpoints: AltEndpointsSchema,
  apiKey: z.string().nullable().optional(),
  extraHeaders: HeadersSchema,
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  /** Route this provider's upstream traffic through a saved proxy. null = direct. */
  proxyId: z.number().int().positive().nullable().optional(),
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
  /** Test through this saved proxy. Omitted on an existing provider = the one
   * it is already attached to. An id, never a host: nothing a caller writes can
   * become a proxy address, only select an existing row. */
  proxyId: z.number().int().positive().nullable().optional(),
});

/**
 * Provider management is admin-only on its write side. A provider row holds
 * upstream credentials, and two mutations in particular are secrets, not
 * configuration: rewriting a keyed provider's baseUrl, or "testing" it with
 * the saved key, both hand the decrypted key to whatever host the caller
 * named. Managers keep the read side (the catalog and service editors need
 * it) but cannot touch credentials.
 */
export async function providerRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ providers: c.providers.list().map((p) => c.providers.toPublic(p)) }));

  app.post("/", async (req, reply) => {
    if (!requireAdmin(req, reply, "create providers")) return reply;
    const parsed = parse(ProviderCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { availableModels, ...input } = parsed.data;
    const provider = c.providers.create(input);
    if (availableModels) c.providerModels.replaceForProvider(provider.id, availableModels);
    return reply.code(201).send({ provider: c.providers.toPublic(provider) });
  });

  app.patch("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "modify providers")) return reply;
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
    if (!requireAdmin(req, reply, "delete providers")) return reply;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.providers.get(id)) return reply.code(404).send({ error: "not found" });
    c.providers.delete(id);
    return { ok: true };
  });

  /** Reach the provider's models endpoint and report what it serves. Read-only:
   * the list is stored when the provider itself is saved, not here, so a test
   * on a form the user then abandons changes nothing. Testing with the form's
   * own key is open to any dashboard user; re-using a STORED key is admin-only,
   * because it sends that decrypted credential to the caller's baseUrl. */
  app.post("/test", async (req, reply) => {
    const parsed = parse(ProviderTest, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { id, type, baseUrl, apiKey, extraHeaders, proxyId } = parsed.data;
    let key = apiKey ?? null;
    const stored = id !== undefined ? c.providers.get(id) : undefined;
    if (apiKey === undefined && id !== undefined) {
      if (!requireAdmin(req, reply, "test a provider with its stored key")) return reply;
      if (!stored) return reply.code(404).send({ error: "not found" });
      key = c.providers.toUpstream(stored).apiKey;
    }
    // The test has to take the SAME route a real call would, for two reasons:
    // a provider reachable only through its proxy would otherwise always report
    // "connection failed", and the stored credential would be sent out on the
    // direct path the operator attached a proxy specifically to avoid.
    // The editor sends the proxy currently selected in the form, so testing an
    // unsaved change works; falling back to the stored one covers a bare id.
    const proxy = c.proxies.forProvider(proxyId !== undefined ? proxyId : stored?.proxyId ?? null);
    return discoverModels(c.transport, { type, baseUrl, apiKey: key, extraHeaders: extraHeaders ?? null, proxy });
  });

  /** The stored list for one provider. */
  app.get("/:id/available-models", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.providers.get(id)) return reply.code(404).send({ error: "not found" });
    return c.providerModels.forProvider(id);
  });
}
