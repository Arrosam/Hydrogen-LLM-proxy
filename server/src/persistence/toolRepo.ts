import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { tools, type ToolRow } from "../db/schema";
import { asMillis } from "../util/time";
import { decryptToolHeaders, encryptToolHeaders } from "../security/toolHeaders";

export type ToolKind = "vocabulary" | "freeform";
export type ToolPolicy = "prefer_provider" | "override";

export interface ToolInput {
  name: string;
  kind?: ToolKind;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
  endpointUrl: string;
  /** Plaintext header map. undefined = leave unchanged (update); null/{} = clear. */
  headers?: Record<string, string> | null;
  policy?: ToolPolicy;
  maxUses?: number;
  timeoutMs?: number;
  proxyId?: number | null;
  enabled?: boolean;
}

/** Tool shape safe to return over the API: never the header values. */
export interface PublicTool {
  id: number;
  name: string;
  kind: ToolKind;
  description: string | null;
  parameters: Record<string, unknown> | null;
  endpointUrl: string;
  /** Which headers are configured, so the editor can show and re-key them
   * without ever receiving the secrets. */
  headerNames: string[];
  policy: ToolPolicy;
  maxUses: number;
  timeoutMs: number;
  proxyId: number | null;
  enabled: boolean;
  createdAt: number;
}

/** A tool resolved for dispatch: the endpoint plus its decrypted headers. */
export interface DispatchableTool {
  id: number;
  name: string;
  kind: ToolKind;
  endpointUrl: string;
  headers: Record<string, string>;
  policy: ToolPolicy;
  maxUses: number;
  timeoutMs: number;
  proxyId: number | null;
}

/**
 * Tool persistence + header (de)cryption, mirroring ProxyRepo exactly: same
 * master-key injection, same "undefined leaves it alone, null clears it"
 * convention on the secret, same toPublic/materialize split.
 *
 * A tool row is only ever a pointer at somebody else's HTTP endpoint. Hydrogen
 * implements no tool, so there is nothing here but addressing, policy and a
 * credential.
 */
export class ToolRepo {
  constructor(
    private readonly db: DB,
    private readonly masterKey: Buffer,
  ) {}

  list(): ToolRow[] {
    return this.db.select().from(tools).all();
  }

  get(id: number): ToolRow | undefined {
    return this.db.select().from(tools).where(eq(tools.id, id)).get();
  }

  /**
   * The row that serves `name` for a given declaration shape.
   *
   * A hosted `{"type":"web_search"}` and a free-form function named
   * `web_search` are different tools that may both be configured; the wire
   * shape the client used picks between them, so the kind is part of the key.
   */
  getByName(name: string, kind: ToolKind): ToolRow | undefined {
    return this.db
      .select()
      .from(tools)
      .where(eq(tools.name, name))
      .all()
      .find((t) => t.kind === kind);
  }

  create(input: ToolInput): ToolRow {
    const cols =
      input.headers && Object.keys(input.headers).length > 0
        ? encryptToolHeaders(input.headers, this.masterKey)
        : { headersCiphertext: null, headersIv: null, headersTag: null };
    return this.db
      .insert(tools)
      .values({
        name: input.name,
        kind: input.kind ?? "freeform",
        description: input.description ?? null,
        parameters: input.parameters ?? null,
        endpointUrl: input.endpointUrl,
        ...cols,
        policy: input.policy ?? "prefer_provider",
        maxUses: input.maxUses ?? 8,
        timeoutMs: input.timeoutMs ?? 30_000,
        proxyId: input.proxyId ?? null,
        enabled: input.enabled ?? true,
      })
      .returning()
      .get();
  }

  update(id: number, input: Partial<ToolInput>): ToolRow | undefined {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.description !== undefined) patch.description = input.description;
    if (input.parameters !== undefined) patch.parameters = input.parameters;
    if (input.endpointUrl !== undefined) patch.endpointUrl = input.endpointUrl;
    if (input.policy !== undefined) patch.policy = input.policy;
    if (input.maxUses !== undefined) patch.maxUses = input.maxUses;
    if (input.timeoutMs !== undefined) patch.timeoutMs = input.timeoutMs;
    if (input.proxyId !== undefined) patch.proxyId = input.proxyId;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    // undefined leaves the stored headers alone; null or {} clears them.
    if (input.headers !== undefined) {
      Object.assign(
        patch,
        input.headers && Object.keys(input.headers).length > 0
          ? encryptToolHeaders(input.headers, this.masterKey)
          : { headersCiphertext: null, headersIv: null, headersTag: null },
      );
    }
    if (Object.keys(patch).length === 0) return this.get(id);
    return this.db.update(tools).set(patch).where(eq(tools.id, id)).returning().get();
  }

  delete(id: number): void {
    this.db.delete(tools).where(eq(tools.id, id)).run();
  }

  toPublic(row: ToolRow): PublicTool {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      description: row.description,
      parameters: row.parameters,
      endpointUrl: row.endpointUrl,
      headerNames: Object.keys(decryptToolHeaders(row, this.masterKey)),
      policy: row.policy,
      maxUses: row.maxUses,
      timeoutMs: row.timeoutMs,
      proxyId: row.proxyId,
      enabled: row.enabled,
      createdAt: asMillis(row.createdAt),
    };
  }

  /** Decrypt a row into the form the dispatcher calls with. */
  materialize(row: ToolRow): DispatchableTool {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      endpointUrl: row.endpointUrl,
      headers: decryptToolHeaders(row, this.masterKey),
      policy: row.policy,
      maxUses: row.maxUses,
      timeoutMs: row.timeoutMs,
      proxyId: row.proxyId,
    };
  }
}
