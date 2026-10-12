import { requireAdmin } from "../../auth/authorization";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../composition/container";
import { UpstreamUrlError } from "../../core/upstream/ssrf";
import { MAX_PORT, MIN_PORT, proxyKey, proxyLabel } from "../../core/upstream/egress/types";
import { errorMessage } from "../../util/errors";
import { HTTP_STATUS } from "../../util/httpStatus";
import { MAX_NAME_LENGTH } from "../limits";
import { badRequest, conflict, loadById, notFound, parseBody } from "./replies";
import { PositiveIntSchema } from "../../util/validate";

/**
 * The Proxies tab's API. Registered under /proxies inside the session-guarded
 * scope, like every other admin route group.
 *
 * Writes are admin-only, matching the rule applied to provider API keys: a
 * proxy carries a credential and decides where this server's traffic goes, so
 * it is not a manager-level knob. Reading the list is not admin-gated, because
 * the provider editor needs it to render its dropdown, and the list has never
 * contained a secret -- `toPublic` reports only whether a password exists.
 */

const HOSTNAME = /^[a-zA-Z0-9._-]+$/;
const MAX_HOSTNAME_LENGTH = 255;
const MAX_PROXY_USERNAME_LENGTH = 255;
const MAX_PROXY_PASSWORD_LENGTH = 1024;

const ProxyCreate = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  scheme: z.enum(["http", "https"]).default("http"),
  host: z
    .string()
    .min(1)
    .max(MAX_HOSTNAME_LENGTH)
    .refine((h) => HOSTNAME.test(h) || h.includes(":"), "host must be a hostname or an IP address"),
  port: z.number().int().min(MIN_PORT).max(MAX_PORT),
  username: z.string().max(MAX_PROXY_USERNAME_LENGTH).nullable().optional(),
  password: z.string().max(MAX_PROXY_PASSWORD_LENGTH).nullable().optional(),
  enabled: z.boolean().optional(),
});

const ProxyUpdate = ProxyCreate.partial();

const ProxyTest = z.object({
  /** Test a saved proxy... */
  id: PositiveIntSchema.optional(),
  /** ...or an unsaved one straight out of the editor. */
  proxy: ProxyCreate.optional(),
  /** Where to prove reachability. Defaults to a stable, boring endpoint. */
  url: z.string().url().optional(),
});

/** What a proxy is proved against when the operator names no target. */
const DEFAULT_PROBE_URL = "https://api.openai.com/v1/models";
const PROXY_PROBE_TIMEOUT_MS = 15_000;

export async function proxyRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ proxies: c.proxies.list().map((p) => c.proxies.toPublic(p)) }));

  app.post("/", async (req, reply) => {
    if (!requireAdmin(req, reply, "create proxies")) return reply;
    const data = parseBody(ProxyCreate, req, reply);
    if (!data) return reply;
    if (c.proxies.getByName(data.name)) {
      return conflict(reply, `a proxy named "${data.name}" already exists`);
    }
    return { proxy: c.proxies.toPublic(c.proxies.create(data)) };
  });

  app.patch("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "modify proxies")) return reply;
    const hit = loadById(req, reply, (id) => c.proxies.get(id));
    if (!hit) return reply;
    const { id, row: before } = hit;
    const data = parseBody(ProxyUpdate, req, reply);
    if (!data) return reply;

    const row = c.proxies.update(id, data);
    // Retire the dispatcher built from the OLD row, so a corrected host or
    // password takes effect on the next request rather than whenever the
    // cached pool happens to age out.
    //
    // ONLY when something the connection depends on changed. Retiring destroys
    // the pool, and undici's destroy() does not drain -- it errors every request
    // already running on it. Renaming a proxy, or toggling `enabled`, would
    // otherwise kill a streaming answer mid-sentence for no reason. `proxyKey`
    // is exactly the set of fields a connection is built from, so comparing it
    // asks the right question.
    if (row) {
      const oldKey = proxyKey(c.proxies.toEgress(before));
      const newKey = proxyKey(c.proxies.toEgress(row));
      if (oldKey !== newKey) c.egressPool.forgetProxy(c.proxies.toEgress(before));
    }
    return { proxy: row ? c.proxies.toPublic(row) : null };
  });

  app.delete("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "delete proxies")) return reply;
    const hit = loadById(req, reply, (id) => c.proxies.get(id));
    if (!hit) return reply;
    const { id, row } = hit;

    // See ProxyRepo.usedBy: the FK's delete action does not exist in the DDL,
    // and silently returning providers to a direct connection is the exact
    // surprise a proxy exists to prevent. Refuse, and name who is using it.
    const inUse = c.proxies.usedBy(id);
    if (inUse.length) {
      return reply.code(HTTP_STATUS.CONFLICT).send({
        error: `proxy "${row.name}" is still used by ${inUse.length} provider(s): ${inUse.map((p) => p.name).join(", ")}. Detach it there first.`,
        providers: inUse,
      });
    }
    c.egressPool.forgetProxy(c.proxies.toEgress(row));
    c.proxies.delete(id);
    return { ok: true };
  });

  /**
   * Prove a proxy actually works, before anything depends on it.
   *
   * Deliberately end-to-end: it opens a real connection through the proxy to a
   * real URL and reports what came back. A proxy that resolves and accepts a
   * TCP connection but refuses to tunnel, or wants credentials, only shows that
   * on a real request -- which is exactly the failure an operator would
   * otherwise discover as a broken provider.
   */
  app.post("/test", async (req, reply) => {
    if (!requireAdmin(req, reply, "test proxies")) return reply;
    const data = parseBody(ProxyTest, req, reply);
    if (!data) return reply;

    const { id, proxy: inline, url } = data;
    let egress;
    if (id != null) {
      const row = c.proxies.get(id);
      if (!row) return notFound(reply);
      egress = c.proxies.toEgress(row);
    } else if (inline) {
      egress = {
        id: 0,
        name: inline.name,
        scheme: inline.scheme,
        host: inline.host,
        port: inline.port,
        username: inline.username ?? null,
        password: inline.password ?? null,
      };
    } else {
      return badRequest(reply, "provide either a saved proxy id or an inline proxy to test");
    }

    const target = url ?? DEFAULT_PROBE_URL;
    const started = Date.now();
    try {
      const res = await c.transport.getJson(target, {}, { timeoutMs: PROXY_PROBE_TIMEOUT_MS, proxy: egress });
      return {
        ok: true,
        status: res.status,
        latencyMs: Date.now() - started,
        url: target,
        // A 401 from the probe URL is a SUCCESS for this test: it means the
        // tunnel carried a real HTTP exchange and something answered. The
        // proxy's job is reachability, not authorization.
        message: `reached ${target} through ${proxyLabel(egress)} (HTTP ${res.status})`,
      };
    } catch (e) {
      const message =
        e instanceof UpstreamUrlError
          ? e.message
          : `could not reach ${target} through ${proxyLabel(egress)}: ${errorMessage(e)}`;
      return { ok: false, status: 0, latencyMs: Date.now() - started, url: target, message };
    }
  });
}
