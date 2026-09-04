import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParam, parse } from "../util/validate";
import type { Container } from "../composition/container";
import { UpstreamUrlError } from "../core/upstream/ssrf";
import { proxyKey, proxyLabel } from "../core/upstream/egress/types";

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

const ProxyCreate = z.object({
  name: z.string().min(1).max(120),
  scheme: z.enum(["http", "https"]).default("http"),
  host: z
    .string()
    .min(1)
    .max(255)
    .refine((h) => HOSTNAME.test(h) || h.includes(":"), "host must be a hostname or an IP address"),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).nullable().optional(),
  password: z.string().max(1024).nullable().optional(),
  enabled: z.boolean().optional(),
});

const ProxyUpdate = ProxyCreate.partial();

const ProxyTest = z.object({
  /** Test a saved proxy... */
  id: z.number().int().positive().optional(),
  /** ...or an unsaved one straight out of the editor. */
  proxy: ProxyCreate.optional(),
  /** Where to prove reachability. Defaults to a stable, boring endpoint. */
  url: z.string().url().optional(),
});

/** What a proxy is proved against when the operator names no target. */
const DEFAULT_PROBE_URL = "https://api.openai.com/v1/models";

export async function proxyRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ proxies: c.proxies.list().map((p) => c.proxies.toPublic(p)) }));

  app.post("/", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can create proxies" });
    const parsed = parse(ProxyCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (c.proxies.getByName(parsed.data.name)) {
      return reply.code(409).send({ error: `a proxy named "${parsed.data.name}" already exists` });
    }
    return { proxy: c.proxies.toPublic(c.proxies.create(parsed.data)) };
  });

  app.patch("/:id", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can modify proxies" });
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const before = c.proxies.get(id);
    if (!before) return reply.code(404).send({ error: "not found" });
    const parsed = parse(ProxyUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const row = c.proxies.update(id, parsed.data);
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
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can delete proxies" });
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const row = c.proxies.get(id);
    if (!row) return reply.code(404).send({ error: "not found" });

    // See ProxyRepo.usedBy: the FK's delete action does not exist in the DDL,
    // and silently returning providers to a direct connection is the exact
    // surprise a proxy exists to prevent. Refuse, and name who is using it.
    const inUse = c.proxies.usedBy(id);
    if (inUse.length) {
      return reply.code(409).send({
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
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can test proxies" });
    const parsed = parse(ProxyTest, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const { id, proxy: inline, url } = parsed.data;
    let egress;
    if (id != null) {
      const row = c.proxies.get(id);
      if (!row) return reply.code(404).send({ error: "not found" });
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
      return reply.code(400).send({ error: "provide either a saved proxy id or an inline proxy to test" });
    }

    const target = url ?? DEFAULT_PROBE_URL;
    const started = Date.now();
    try {
      const res = await c.transport.getJson(target, {}, { timeoutMs: 15_000, proxy: egress });
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
          : `could not reach ${target} through ${proxyLabel(egress)}: ${e instanceof Error ? e.message : String(e)}`;
      return { ok: false, status: 0, latencyMs: Date.now() - started, url: target, message };
    }
  });
}
