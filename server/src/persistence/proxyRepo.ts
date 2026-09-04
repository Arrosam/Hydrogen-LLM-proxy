import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { providers, proxies, type ProxyRow } from "../db/schema";
import { asMillis } from "../util/time";
import { decryptProxyPassword, encryptProxyPassword } from "../security/proxySecret";
import type { EgressProxy } from "../core/upstream/egress/types";

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
 * Proxy persistence + password (de)cryption, mirroring ProviderRepo exactly:
 * same master-key injection, same "undefined leaves it alone, null clears it"
 * convention on the secret, same toPublic/materialize split.
 */
export class ProxyRepo {
  constructor(
    private readonly db: DB,
    private readonly masterKey: Buffer,
  ) {}

  list(): ProxyRow[] {
    return this.db.select().from(proxies).all();
  }

  get(id: number): ProxyRow | undefined {
    return this.db.select().from(proxies).where(eq(proxies.id, id)).get();
  }

  getByName(name: string): ProxyRow | undefined {
    return this.db.select().from(proxies).where(eq(proxies.name, name)).get();
  }

  create(input: ProxyInput): ProxyRow {
    const cols =
      input.password && input.password.length > 0
        ? encryptProxyPassword(input.password, this.masterKey)
        : { passwordCiphertext: null, passwordIv: null, passwordTag: null };
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
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.scheme !== undefined) patch.scheme = input.scheme;
    if (input.host !== undefined) patch.host = input.host;
    if (input.port !== undefined) patch.port = input.port;
    if (input.username !== undefined) patch.username = input.username;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.password !== undefined) {
      if (input.password === null || input.password === "") {
        Object.assign(patch, { passwordCiphertext: null, passwordIv: null, passwordTag: null });
      } else {
        Object.assign(patch, encryptProxyPassword(input.password, this.masterKey));
      }
    }
    if (Object.keys(patch).length === 0) return this.get(id);
    return this.db.update(proxies).set(patch).where(eq(proxies.id, id)).returning().get();
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

  delete(id: number): void {
    this.db.delete(proxies).where(eq(proxies.id, id)).run();
  }

  toPublic(p: ProxyRow): PublicProxy {
    return {
      id: p.id,
      name: p.name,
      scheme: p.scheme,
      host: p.host,
      port: p.port,
      username: p.username ?? null,
      hasPassword: Boolean(p.passwordCiphertext),
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
   * The proxy a provider should egress through, or null.
   *
   * Null covers three cases that are deliberately identical to the caller: the
   * provider has no proxy, the proxy row is gone, or the proxy is disabled.
   * Disabling a proxy therefore returns its providers to a direct connection,
   * which is the one place that is the right default -- it is an explicit
   * operator action on the proxy itself, not a silent failure.
   */
  forProvider(proxyId: number | null | undefined): EgressProxy | null {
    if (proxyId == null) return null;
    const row = this.get(proxyId);
    if (!row || !row.enabled) return null;
    return this.toEgress(row);
  }
}
