import { asc, eq } from "drizzle-orm";
import type { DB } from "../db";
import { providerAvailableModels, type ProviderAvailableModel } from "../db/schema";
import { asMillis } from "../util/time";

/** One provider's discovered model list, as the dashboard consumes it. */
export interface ProviderModelList {
  providerId: number;
  models: string[];
  /** When the list was last refreshed, or null when nothing is stored. */
  fetchedAt: number | null;
}

/**
 * The model ids each provider reported from its own /models endpoint.
 *
 * This is a cache of what the upstream offers, not configuration: a provider's
 * list is replaced wholesale on every refresh, so a model the provider retired
 * disappears rather than lingering. Rows go away with their provider (FK
 * cascade), and nothing in the proxy path reads them — they exist so mapping a
 * catalog model to a provider can be a pick from a list.
 */
export class ProviderModelRepo {
  constructor(private readonly db: DB) {}

  private rowsFor(providerId: number): ProviderAvailableModel[] {
    return this.db
      .select()
      .from(providerAvailableModels)
      .where(eq(providerAvailableModels.providerId, providerId))
      .orderBy(asc(providerAvailableModels.id))
      .all();
  }

  /** The model ids stored for one provider, in the order they were reported. */
  listForProvider(providerId: number): string[] {
    return this.rowsFor(providerId).map((r) => r.modelId);
  }

  forProvider(providerId: number): ProviderModelList {
    const rows = this.rowsFor(providerId);
    return {
      providerId,
      models: rows.map((r) => r.modelId),
      fetchedAt: rows.length ? Math.max(...rows.map((r) => asMillis(r.createdAt))) : null,
    };
  }

  /** Every provider that has a stored list, keyed by provider id. */
  grouped(): ProviderModelList[] {
    const rows = this.db
      .select()
      .from(providerAvailableModels)
      .orderBy(asc(providerAvailableModels.id))
      .all();
    const byProvider = new Map<number, ProviderModelList>();
    for (const row of rows) {
      let entry = byProvider.get(row.providerId);
      if (!entry) {
        entry = { providerId: row.providerId, models: [], fetchedAt: null };
        byProvider.set(row.providerId, entry);
      }
      entry.models.push(row.modelId);
      const at = asMillis(row.createdAt);
      if (entry.fetchedAt === null || at > entry.fetchedAt) entry.fetchedAt = at;
    }
    return [...byProvider.values()];
  }

  /**
   * Make `models` the provider's whole list. One transaction, so a failed write
   * can't leave the provider with half of a refresh. Duplicates and blanks are
   * dropped here as well as at the route, since the unique index would
   * otherwise turn a sloppy upstream response into a failed save.
   */
  replaceForProvider(providerId: number, models: string[]): number {
    const clean: string[] = [];
    const seen = new Set<string>();
    for (const raw of models) {
      const id = raw.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      clean.push(id);
    }
    this.db.transaction((tx) => {
      tx.delete(providerAvailableModels).where(eq(providerAvailableModels.providerId, providerId)).run();
      // Chunked: SQLite caps the number of bound variables in one statement.
      for (let i = 0; i < clean.length; i += 200) {
        tx.insert(providerAvailableModels)
          .values(clean.slice(i, i + 200).map((modelId) => ({ providerId, modelId })))
          .run();
      }
    });
    return clean.length;
  }

  /** Drop a provider's list without touching the provider itself. */
  clearForProvider(providerId: number): void {
    this.db.delete(providerAvailableModels).where(eq(providerAvailableModels.providerId, providerId)).run();
  }
}
