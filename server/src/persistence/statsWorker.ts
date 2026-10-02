import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import * as schema from "../db/schema";
import { StatsQueries } from "./statsQueries";
import type { StatsWorkerData } from "./statsReader";
import { startupStage, type StartupReporter } from "../util/startup";

const { databasePath, sinceId, throughId } = workerData as StatsWorkerData;
const report: StartupReporter = event => parentPort!.postMessage({ kind: "startup", event });
let sqlite: Database.Database | undefined;
try {
  sqlite = startupStage(report, "stats.worker.open", () => new Database(databasePath, { readonly: true, fileMustExist: true }));
  const queries = new StatsQueries(drizzle(sqlite, { schema }));
  const accumulator = startupStage(report, "stats.worker.scan", () => queries.accumulateSince(sinceId, throughId));
  sqlite.close(); sqlite = undefined;
  parentPort!.postMessage({ kind: "result", accumulator });
} catch {
  parentPort!.postMessage({ kind: "failed" });
} finally { sqlite?.close(); }
