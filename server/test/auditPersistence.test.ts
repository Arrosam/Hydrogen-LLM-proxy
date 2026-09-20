import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { openDatabase, schema } from "../src/db";
import { seedAdminIfEmpty } from "../src/db/bootstrap";
import { hashPassword, verifyPassword } from "../src/security/passwords";
import { ImageDescriptionCache } from "../src/execution/ocrCache";
import type { ImageCacheRepo } from "../src/persistence/imageCacheRepo";
import { LogPruner } from "../src/persistence/logPruner";
const dirs: string[] = [];
const connections: ReturnType<typeof openDatabase>[] = [];
function database() { const dir = mkdtempSync(join(tmpdir(),"audit-db-")); dirs.push(dir); const opened=openDatabase(dir);connections.push(opened);return opened; }
afterEach(()=>{vi.restoreAllMocks();connections.splice(0).forEach(c=>c.sqlite.close());dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
it("fresh migrations match every schema table, column and declared index",()=>{
 const {sqlite}=database();
 for(const table of Object.values(schema).filter(isTable)) {
  const name=getTableName(table);
  const columns=sqlite.pragma(`table_info('${name}')`) as Array<{name:string;notnull:number;pk:number}>;
  expect(columns.map(c=>c.name).sort()).toEqual(Object.values(getTableColumns(table)).map(c=>c.name).sort());
  for(const column of Object.values(getTableColumns(table))) {const found=columns.find(c=>c.name===column.name)!;expect(Boolean(found.notnull||found.pk)).toBe(column.notNull);}
  const indexes=sqlite.pragma(`index_list('${name}')`) as Array<{name:string}>;
  for(const index of getTableConfig(table).indexes) expect(indexes.map(i=>i.name)).toContain(index.config.name);
 }
});
it("bootstrap generates a secret and rotates only unfinished historical default credentials",async()=>{
 const {db}=database();const first=await seedAdminIfEmpty(db,{username:"admin",password:""});
 expect(first.password).toHaveLength(32);expect(first.mustChange).toBe(true);
 const user=db.select().from(schema.users).get()!;expect(await verifyPassword(user.passwordHash,first.password!)).toBe(true);
 db.update(schema.users).set({passwordHash:await hashPassword("password")}).run();
 const upgraded=await seedAdminIfEmpty(db,{username:"admin",password:""});expect(upgraded.password).not.toBe(first.password);expect(upgraded.password).not.toBe("password");
 expect(db.select().from(schema.settings).all().some(r=>r.key==="session_epoch")).toBe(true);
 expect((await seedAdminIfEmpty(db,{username:"admin",password:""})).created).toBe(false);
});
it("OCR overlapping fills wait for published cache entries and cancelled waiters release their slots",async()=>{
 const values=new Map<string,string>();
 const cache=new ImageDescriptionCache({lookup:(keys:string[])=>new Map(keys.filter(k=>values.has(k)).map(k=>[k,values.get(k)!])),put:(entries:Array<{hash:string;description:string}>)=>entries.forEach(e=>values.set(e.hash,e.description))} as unknown as ImageCacheRepo,()=>1000);
 const release=await cache.acquire(["a"]);const abort=new AbortController();const cancelled=cache.acquire(["a"],abort.signal);abort.abort(new Error("cancelled"));await expect(cancelled).rejects.toThrow("cancelled");
 let entered=false;const waiting=cache.acquire(["a","b"]).then(done=>{entered=true;expect(cache.lookup(["a"]).get("a")).toBe("cached");done();});
 await Promise.resolve();expect(entered).toBe(false);cache.store([{hash:"a",description:"cached"}]);release();await waiting;
 const after=await cache.acquire(["b","a"]);after();
});
it("log pruning keeps boundary rows and respects disabled limits",()=>{
 const {sqlite,db}=database();const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now);
 for(const [id,created] of [[1,now-86400001],[2,now-86400000],[3,now]]) sqlite.prepare("INSERT INTO request_logs (id,trace_id,created_at,ingress_format,streaming,http_status,latency_ms,attempts) VALUES (?, ?, ?, 'openai_completion', 0, 200, 1, 1)").run(id,String(id),created);
 const pruner=new LogPruner(db);expect(pruner.pruneOlderThan(0)).toBe(0);expect(pruner.pruneOlderThan(1)).toBe(1);expect(pruner.capRows(0)).toBe(0);expect(pruner.capRows(1)).toBe(1);expect(sqlite.prepare("SELECT id FROM request_logs").all()).toEqual([{id:3}]);
});
