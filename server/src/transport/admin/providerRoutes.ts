import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization";
import { discoverModels, MAX_DISCOVERED_MODELS, MAX_MODEL_ID_LENGTH } from "../../catalog/modelDiscovery";
import type { Container } from "../../composition/container";
import { FAMILIES } from "../../core/ir/params";
import { HTTP_STATUS } from "../../util/httpStatus";
import { MAX_NAME_LENGTH } from "../limits";
import { loadById, notFound, parseBody } from "./replies";
import { PositiveIntSchema } from "../../util/validate";

/** Alternate endpoints a provider may declare beside its primary. */
const MAX_ALT_ENDPOINTS = 4;

// --- providers --------------------------------------------------------------

const TypeSchema = z.enum(FAMILIES);
const HeadersSchema = z.record(z.string(), z.string()).nullable().optional();
const BaseUrlSchema = z
  .string()
  .url()
  // zod still runs a refinement on a string `.url()` has already refused, so
  // the scheme is only judged on something that parses (a non-URL keeps the
  // one "Invalid url" issue instead of throwing out of the schema).
  .refine((u) => !URL.canParse(u) || /^https?:$/.test(new URL(u).protocol), { message: "baseUrl must use http or https" });

/** The model list captured from a provider test, persisted alongside the save.
 * Omitted = leave whatever is stored alone; `[]` = the provider reported none. */
const AvailableModelsSchema = z
  .array(z.string().min(1).max(MAX_MODEL_ID_LENGTH))
  .max(MAX_DISCOVERED_MODELS)
  .optional();

const AltEndpointsSchema = z.array(z.object({ type: TypeSchema, baseUrl: BaseUrlSchema })).max(MAX_ALT_ENDPOINTS).nullable().optional();
const ProviderCreate = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  type: TypeSchema,
  baseUrl: BaseUrlSchema,
  altEndpoints: AltEndpointsSchema,
  apiKey: z.string().nullable().optional(),
  extraHeaders: HeadersSchema,
  maxOutputTokens: PositiveIntSchema.nullable().optional(),
  /** Route this provider's upstream traffic through a saved proxy. null = direct. */
  proxyId: PositiveIntSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  availableModels: AvailableModelsSchema,
});
const ProviderUpdate = ProviderCreate.partial();

/**
 * A provider test runs against the form in front of the user, not against what
 * is stored — that is the whole point of testing before saving. `id` is only
 * consulted to reuse the saved key when the key field was left blank (the
 * dashboard never sends a key it doesn't have the plaintext for).
 *
 * `proxyId` tests through that saved proxy; omitted on an existing provider =
 * the one it is already attached to. An id, never a host: nothing a caller
 * writes can become a proxy address, only select an existing row.
 */
const ProviderTest = z.object({
  id: PositiveIntSchema.optional(),
  ...ProviderCreate.pick({ type: true, baseUrl: true, apiKey: true, extraHeaders: true, proxyId: true }).shape,
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
    const data = parseBody(ProviderCreate, req, reply);
    if (!data) return reply;
    const { availableModels, ...input } = data;
    const provider = c.providers.create(input);
    if (availableModels) c.providerModels.replaceForProvider(provider.id, availableModels);
    return reply.code(HTTP_STATUS.CREATED).send({ provider: c.providers.toPublic(provider) });
  });

  app.patch("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "modify providers")) return reply;
    const hit = loadById(req, reply, (id) => c.providers.get(id));
    if (!hit) return reply;
    const data = parseBody(ProviderUpdate, req, reply);
    if (!data) return reply;
    const { availableModels, ...input } = data;
    const provider = c.providers.update(hit.id, input);
    if (availableModels) c.providerModels.replaceForProvider(hit.id, availableModels);
    return { provider: provider ? c.providers.toPublic(provider) : null };
  });

  app.delete("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "delete providers")) return reply;
    const hit = loadById(req, reply, (id) => c.providers.get(id));
    if (!hit) return reply;
    c.providers.delete(hit.id);
    return { ok: true };
  });

  /** Reach the provider's models endpoint and report what it serves. Read-only:
   * the list is stored when the provider itself is saved, not here, so a test
   * on a form the user then abandons changes nothing. Testing with the form's
   * own key is open to any dashboard user; re-using a STORED key is admin-only,
   * because it sends that decrypted credential to the caller's baseUrl. */
  app.post("/test", async (req, reply) => {
    const data = parseBody(ProviderTest, req, reply);
    if (!data) return reply;
    const { id, type, baseUrl, apiKey, extraHeaders, proxyId } = data;
    let key = apiKey ?? null;
    const stored = id !== undefined ? c.providers.get(id) : undefined;
    if (apiKey === undefined && id !== undefined) {
      if (!requireAdmin(req, reply, "test a provider with its stored key")) return reply;
      if (!stored) return notFound(reply);
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
    const hit = loadById(req, reply, (id) => c.providers.get(id));
    if (!hit) return reply;
    return c.providerModels.forProvider(hit.id);
  });
}
