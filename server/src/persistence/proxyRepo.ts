import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { providers, proxies, type ProxyRow } from "../db/schema";
import { asMillis } from "../util/time";
import { decryptProxyPassword, encryptProxyPassword, type ProxyPasswordColumns } from "../security/proxySecret";
import { pickDefined, TableRepo } from "./tableRepo";
import type { EgressProxy } from "../core/upstream/egress/types";
import { STATUS_UPSTREAM_FAILURE } from "../util/httpStatus";

export interface ProxyInput {
  name: string;
  scheme: "http" | "https";
  host: string;
  port: number;
  username?: string | null;
  /** Plaintext password. undefined = leave unchanged (update); null/"" = clear. */
  password?: string | null;
  enabled?: boolean;
}

/** Proxy shape safe to return over the API: never the password. */
export interface PublicProxy {
  id: number;
  name: string;
  scheme: "http" | "https";
  host: string;
  port: number;
  username: string | null;
  hasPassword: boolean;
  enabled: boolean;
  createdAt: number;
}

/**
 * A provider names an egress proxy whose row is gone. Thrown rather than
 * answered with "no proxy": the reference is dangling, so sending the
 * provider's traffic (and its credential) out directly would be the silent
 * bypass a proxy exists to prevent. The catalog turns it into an unresolvable
 * mapping, so a call through that provider fails before any socket is opened.
 */
export class EgressProxyMissingError extends Error {
  /** A broken upstream route, not a caller mistake. */
  readonly statusCode = STATUS_UPSTREAM_FAILURE;
  constructor(readonly proxyId: number) {
    super(`egress proxy #${proxyId} no longer exists; re-attach a proxy to the provider or set it to a direct connection`);
    this.name = "EgressProxyMissingError";
  }
}

/** The plain columns an update may set; the password has its own rule. */
const PATCHABLE = ["name", "scheme", "host", "port", "username", "enabled"] as const;

/**
 * Proxy persistence + password (de)cryption, mirroring ProviderRepo exactly:
 * same master-key injection, same "undefined leaves it alone, null clears it"
 * convention on the secret, same toPublic/materialize split.
 */
export class ProxyRepo extends TableRepo<typeof proxies> {
  constructor(
    db: DB,
    private readonly masterKey: Buffer,
  ) {
    super(db, proxies);
  }

  getByName(name: string): ProxyRow | undefined {
    return this.findBy(proxies.name, name);
  }

  /** The password columns for a plaintext password; none (null, "" or absent) clears them. */
  private passwordColumns(password: string | null | undefined): ProxyPasswordColumns {
    return password ? encryptProxyPassword(password, this.masterKey) : { passwordCiphertext: null, passwordIv: null, passwordTag: null };
  }

  create(input: ProxyInput): ProxyRow {
    const cols = this.passwordColumns(input.password);
    return this.db
      .insert(proxies)
      .values({
        name: input.name,
        scheme: input.scheme,
        host: input.host,
        port: input.port,
        username: input.username ?? null,
        ...cols,
        enabled: input.enabled ?? true,
      })
      .returning()
      .get();
  }

  update(id: number, input: Partial<ProxyInput>): ProxyRow | undefined {
    const patch: Partial<typeof proxies.$inferInsert> = pickDefined(input, PATCHABLE);
    if (input.password !== undefined) Object.assign(patch, this.passwordColumns(input.password));
    return this.patch(id, patch);
  }

  /**
   * Providers currently pointing at this proxy.
   *
   * The schema declares `onDelete: "set null"`, but SQLite's ALTER TABLE ADD
   * COLUMN cannot carry a delete action, so the column added by migration 0007
   * has a plain REFERENCES and the action never runs. Rather than depend on an
   * FK behaviour the DDL does not have, deletion asks this first and refuses
   * while anything is attached -- which is also the more honest answer: a
   * provider silently reverting to a direct connection is exactly the surprise
   * a proxy exists to prevent.
   */
  usedBy(id: number): Array<{ id: number; name: string }> {
    return this.db
      .select({ id: providers.id, name: providers.name })
      .from(providers)
      .where(eq(providers.proxyId, id))
      .all();
  }

  toPublic(p: ProxyRow): PublicProxy {
    return {
      id: p.id,
      name: p.name,
      scheme: p.scheme,
      host: p.host,
      port: p.port,
      username: p.username ?? null,
      // All three columns, as decryptProxyPassword requires.
      hasPassword: Boolean(p.passwordCiphertext && p.passwordIv && p.passwordTag),
      enabled: p.enabled,
      createdAt: asMillis(p.createdAt),
    };
  }

  /**
   * Materialize a proxy row (decrypted password) for actually connecting
   * through it. The only place the password is decrypted.
   */
  toEgress(p: ProxyRow): EgressProxy {
    return {
      id: p.id,
      name: p.name,
      scheme: p.scheme,
      host: p.host,
      port: p.port,
      username: p.username ?? null,
      password: decryptProxyPassword(p, this.masterKey),
    };
  }

  /**
   * The proxy a provider should egress through, or null for a direct
   * connection.
   *
   * Null covers two cases: the provider has no proxy, or its proxy is disabled.
   * Disabling a proxy returns its providers to a direct connection, which is
   * the one place that is the right default -- it is an explicit operator
   * action on the proxy itself (and what the Proxies page says it does), not a
   * silent failure.
   *
   * A proxy id whose row is gone is neither: nobody chose a direct connection
   * for that provider, so it throws {@link EgressProxyMissingError} instead of
   * failing open.
   */
  forProvider(proxyId: number | null | undefined): EgressProxy | null {
    if (proxyId == null) return null;
    const row = this.get(proxyId);
    if (!row) throw new EgressProxyMissingError(proxyId);
    if (!row.enabled) return null;
    return this.toEgress(row);
  }
}
