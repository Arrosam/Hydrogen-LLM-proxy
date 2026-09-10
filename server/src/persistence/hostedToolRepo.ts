import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { hostedTools, serviceTools } from "../db/schema";
import { HttpToolSchema, type HttpTool } from "../execution/toolHttp";
import { decryptSecret, encryptSecret } from "../security/crypto";
import { toolValidator } from "../execution/toolSchema";

type ToolRow = typeof hostedTools.$inferSelect;
export type PublicHostedTool = Omit<HttpTool, "headers"> & { id: number; headerNames: string[]; hasHeaders: boolean };

export class HostedToolRepo {
  constructor(private readonly db: DB, private readonly masterKey: Buffer) {}

  get(id: number): ToolRow | undefined {
    return this.db.select().from(hostedTools).where(eq(hostedTools.id, id)).get();
  }

  list(): PublicHostedTool[] {
    return this.db.select().from(hostedTools).all().map(row => this.public(row));
  }

  public(row: ToolRow): PublicHostedTool {
    const { headers, ...tool } = this.materialize(row);
    return { ...tool, id: row.id, headerNames: Object.keys(headers), hasHeaders: Object.keys(headers).length > 0 };
  }

  materialize(row: ToolRow): HttpTool {
    return { ...row.config, name: row.name, enabled: row.enabled, headers: JSON.parse(decryptSecret(row.headersSecret, this.masterKey)) as Record<string, string> };
  }

  create(input: HttpTool): PublicHostedTool {
    const { headers, ...config } = HttpToolSchema.parse(input);
    toolValidator(config.parameters);
    const row = this.db.insert(hostedTools).values({ name: config.name, config, enabled: config.enabled, headersSecret: encryptSecret(JSON.stringify(headers), this.masterKey) }).returning().get();
    return this.public(row);
  }

  update(id: number, input: Omit<HttpTool, "headers"> & { headers?: Record<string, string> }): PublicHostedTool | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = HttpToolSchema.parse({ ...input, headers: input.headers ?? this.materialize(existing).headers });
    const { headers, ...config } = merged;
    toolValidator(config.parameters);
    const row = this.db.update(hostedTools).set({ name: config.name, config, enabled: config.enabled, headersSecret: encryptSecret(JSON.stringify(headers), this.masterKey) }).where(eq(hostedTools.id, id)).returning().get();
    return this.public(row);
  }

  delete(id: number): void {
    this.db.delete(hostedTools).where(eq(hostedTools.id, id)).run();
  }

  boundIds(serviceId: number): number[] {
    return this.db.select().from(serviceTools).where(eq(serviceTools.serviceId, serviceId)).all().map(row => row.toolId);
  }

  bind(serviceId: number, toolIds: number[]): void {
    this.db.transaction(tx => {
      tx.delete(serviceTools).where(eq(serviceTools.serviceId, serviceId)).run();
      const ids = [...new Set(toolIds)];
      if (ids.length) tx.insert(serviceTools).values(ids.map(toolId => ({ serviceId, toolId }))).run();
    });
  }

  forService(serviceId: number): HttpTool[] {
    const ids = this.boundIds(serviceId);
    if (!ids.length) return [];
    return this.db.select().from(hostedTools).where(and(inArray(hostedTools.id, ids), eq(hostedTools.enabled, true))).all().map(row => this.materialize(row));
  }
}
