import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import { ResponseRetentionQueries, runResponseRetentionCycle, retentionBusy, type RetentionCursor } from "./responseRetention";

export interface ResponsePruneWorkerData { databasePath: string; cursor: RetentionCursor }
const { databasePath, cursor: previous } = workerData as ResponsePruneWorkerData;

async function run(): Promise<void> {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(databasePath, { fileMustExist: true, timeout: 0 });
    sqlite.pragma("foreign_keys = ON");
    // Application writes win; retry later instead of busy-waiting.
    sqlite.pragma("busy_timeout = 0");
    const queries = new ResponseRetentionQueries(sqlite);
    const result = await runResponseRetentionCycle(queries, previous);
    sqlite.close(); sqlite = undefined;
    parentPort!.postMessage({ kind: "result", result });
  } catch (error) {
    // Never send SQL, filenames, settings, snapshots or payloads to diagnostics.
    parentPort!.postMessage({ kind: "failed", busy: retentionBusy(error) });
  } finally { sqlite?.close(); }
}
void run();
