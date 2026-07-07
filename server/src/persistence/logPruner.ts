import { desc, lt, lte } from "drizzle-orm";
import type { DB } from "../db";
import { requestLogs } from "../db/schema";

/** Bounds the request_logs table: prune by age and/or cap the row count. */
export class LogPruner {
  constructor(private readonly db: DB) {}

  /** Delete logs older than `retentionDays`. Returns the number deleted. */
  pruneOlderThan(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const res = this.db.delete(requestLogs).where(lt(requestLogs.createdAt, cutoff)).run();
    return res.changes ?? 0;
  }

  /** Keep only the most recent `maxRows` rows. Returns the number deleted. */
  capRows(maxRows: number): number {
    if (maxRows <= 0) return 0;
    const threshold = this.db
      .select({ id: requestLogs.id })
      .from(requestLogs)
      .orderBy(desc(requestLogs.id))
      .limit(1)
      .offset(maxRows)
      .get();
    if (!threshold) return 0;
    const res = this.db.delete(requestLogs).where(lte(requestLogs.id, threshold.id)).run();
    return res.changes ?? 0;
  }
}
