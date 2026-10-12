import { eq } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { DB } from "../db";

/** A table addressed by an integer `id` primary key. */
type IdTable = SQLiteTable & { id: SQLiteColumn };

/**
 * The fields of `input` named in `keys` that were actually given. `undefined`
 * means "leave unchanged" in every repository's update, so it never reaches the
 * patch; `null` is a value and does.
 */
export function pickDefined<T extends object, K extends keyof T>(input: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const patch: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  return patch;
}

/**
 * What every id-keyed repository does the same way: list, get, delete, look a
 * row up by one column, and apply a partial update. A repository extends this
 * with its own create/update (which decide what goes into the patch) and its
 * row mapping.
 */
export abstract class TableRepo<TTable extends IdTable> {
  protected constructor(
    protected readonly db: DB,
    private readonly table: TTable,
  ) {}

  list(): TTable["$inferSelect"][] {
    return this.db.select().from(this.table as IdTable).all() as TTable["$inferSelect"][];
  }

  get(id: number): TTable["$inferSelect"] | undefined {
    return this.findBy(this.table.id, id);
  }

  delete(id: number): void {
    this.db.delete(this.table).where(eq(this.table.id, id)).run();
  }

  /** The row whose (unique) `column` equals `value`. */
  protected findBy(column: SQLiteColumn, value: unknown): TTable["$inferSelect"] | undefined {
    return this.db.select().from(this.table as IdTable).where(eq(column, value)).get() as TTable["$inferSelect"] | undefined;
  }

  /** Write `patch` to row `id` and return the row as stored. An empty patch
   * writes nothing and returns the current row. */
  protected patch(id: number, patch: Partial<TTable["$inferInsert"]>): TTable["$inferSelect"] | undefined {
    if (Object.keys(patch).length === 0) return this.get(id);
    return this.db.update(this.table as IdTable).set(patch as never).where(eq(this.table.id, id)).returning().get() as TTable["$inferSelect"] | undefined;
  }
}
