import type { FastifyInstance } from "fastify";
import net from "node:net";
import { z } from "zod";
import { parse } from "../../util/validate";
import { readUpstreamAllowlist, writeUpstreamAllowlist } from "../../services/settings";

/** A valid allowlist entry: exact IP, v4 CIDR, or hostname (optional leading dot). */
function isValidEntry(raw: string): boolean {
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

const PutSchema = z.object({ entries: z.array(z.string()).max(200) });

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/upstream-allowlist", async () => ({ entries: readUpstreamAllowlist() }));

  app.put("/upstream-allowlist", async (req, reply) => {
    if (req.user?.role !== "admin") {
      return reply.code(403).send({ error: "only an admin can edit the upstream allowlist" });
    }
    const parsed = parse(PutSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const entries = Array.from(new Set(parsed.data.entries.map((e) => e.trim()).filter(Boolean)));
    const bad = entries.filter((e) => !isValidEntry(e));
    if (bad.length) {
      return reply.code(400).send({ error: `invalid entries (use IP, v4 CIDR, or hostname): ${bad.join(", ")}` });
    }
    writeUpstreamAllowlist(entries);
    return { entries };
  });
}
