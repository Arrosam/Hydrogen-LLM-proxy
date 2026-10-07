// node scripts/validate-response-retention-image.mjs <image@sha256:digest> <commit> <version>
// Requires the immutable image to be pulled first. Disposable named volume only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

const [image, sha, version] = process.argv.slice(2);
assert.match(image ?? "", /^ghcr\.io\/arrosam\/hydrogen-llm-proxy@sha256:[a-f0-9]{64}$/);
assert.match(sha ?? "", /^[a-f0-9]{40}$/);
assert.match(version ?? "", /^\d+\.\d+\.\d+-preview\.\d+$/);
const name = `hydrogen-retention-smoke-${randomUUID()}`, seedName = `${name}-seed`, volume = `${name}-data`;
const run = promisify(execFile);
const docker = async args => (await run("docker", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const token = "synthetic-immutable-image-owner-token", password = "synthetic-immutable-image-password";
const limits = ["--platform", "linux/amd64", "--cpus", "1", "--memory", "256m", "--pids-limit", "96", "--pull", "never"];
let failure;
try {
  const metadata = JSON.parse(await docker(["image", "inspect", image]))[0];
  assert.equal(metadata.Os, "linux"); assert.equal(metadata.Architecture, "amd64");
  assert.equal(metadata.Config.User, "node");
  assert.deepEqual(metadata.Config.Cmd, ["node", "server/dist/server.cjs"]);
  assert(metadata.Config.Env.includes(`GIT_SHA=${sha}`));
  await docker(["volume", "create", volume]);
  const seed = `
    const assert = require('node:assert/strict'), fs = require('node:fs'), crypto = require('node:crypto');
    const Database = require('better-sqlite3');
    for (const location of ['/app/package.json','/app/server/package.json','/app/web/package.json'])
      assert.equal(require(location).version, ${JSON.stringify(version)});
    const worker = fs.readFileSync('/app/server/dist/response-prune-worker.cjs');
    const db = new Database('/data/hydrogen.db'); db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
    require('drizzle-orm/better-sqlite3/migrator').migrate(require('drizzle-orm/better-sqlite3').drizzle(db), {migrationsFolder:'/app/server/drizzle'});
    const now = Date.now(), day = 86400000;
    const owner = db.prepare('INSERT INTO tokens(name,key_hash,key_prefix) VALUES (?,?,?) RETURNING id')
      .get('synthetic-owner',crypto.createHash('sha256').update(${JSON.stringify(token)}).digest('hex'),'synthetic').id;
    db.transaction(() => {
      db.prepare("INSERT INTO settings VALUES ('response_retention_days','0'),('validation-sentinel','preserve-config')").run();
      db.prepare("INSERT INTO image_cache(hash,description,size_bytes,last_used_at) VALUES ('synthetic-image','preserve-image',14,?)").run(now);
      const conversation = db.prepare("INSERT INTO response_conversations(id,token_id,metadata_json,touched_at) VALUES (?,?,'{}',?)");
      const item = db.prepare("INSERT INTO conversation_items(id,conversation_id,item_json) VALUES (?,?,'{}')");
      for (let i=0;i<100;i++) { conversation.run('old-conv-'+i,owner,now-2*day); item.run('old-item-'+i,'old-conv-'+i); }
      const response = db.prepare("INSERT INTO stored_responses(id,token_id,status,response_json,input_items_json,history_json,touched_at,conversation_id) VALUES (?,?,'completed',?,'[]','[]',?,?)");
      const event = db.prepare("INSERT INTO response_events(response_id,event) VALUES (?,'{}')");
      for(let i=0;i<3072;i++) { const old=i<1024, id=(old?'old-':'fresh-')+i;
        response.run(id,owner,JSON.stringify({id,status:'completed',output:[],synthetic:'x'.repeat(4096)}),old?now-2*day:now,old?'old-conv-'+(i%100):null);
        if(old) event.run(id); }
    })();
    const bytes=fs.readdirSync('/data').filter(n=>/\\.db(?:-wal|-shm)?$/.test(n)).reduce((sum,n)=>sum+fs.statSync('/data/'+n).size,0);
    assert(bytes<128*1024*1024); db.close();
    console.log(JSON.stringify({fixtureBytes:bytes,workerSha256:crypto.createHash('sha256').update(worker).digest('hex')}));
  `;
  const seeded = JSON.parse(await docker(["run", "--rm", "--name", seedName, ...limits, "--mount", `type=volume,source=${volume},target=/data`, "--entrypoint", "node", image, "--max-old-space-size=128", "-e", seed]));
  const read = `const Database=require('better-sqlite3'); const db=new Database('/data/hydrogen.db',{readonly:true,fileMustExist:true,timeout:1000});
    const counts=Object.fromEntries(['stored_responses','response_events','response_conversations','conversation_items'].map(t=>[t,db.prepare('SELECT count(*) AS n FROM '+t).get().n]));
    console.log(JSON.stringify({counts,setting:db.prepare("SELECT value FROM settings WHERE key='response_retention_days'").get().value,
      configuration:db.prepare("SELECT value FROM settings WHERE key='validation-sentinel'").get().value,
      imageCache:db.prepare("SELECT description FROM image_cache WHERE hash='synthetic-image'").get().description,
      foreignKeys:db.prepare('PRAGMA foreign_key_check').all()})); db.close();`;
  const state = async () => JSON.parse(await docker(["exec", name, "node", "-e", read]));
  const started = performance.now();
  await docker(["run", "--detach", "--name", name, ...limits, "--mount", `type=volume,source=${volume},target=/data`,
    "--publish", "127.0.0.1::8080", "--env", "HOST=0.0.0.0", "--env", "PROXY_MASTER_KEY="+"27".repeat(32),
    "--env", "SESSION_SECRET=synthetic-immutable-image-session", "--env", `ADMIN_PASSWORD=${password}`,
    "--env", "NODE_OPTIONS=--max-old-space-size=128", "--env", "HYDROGEN_HEAP_AUTOSIZE=0", image]);
  const container = JSON.parse(await docker(["inspect", name]))[0];
  const base = `http://127.0.0.1:${container.NetworkSettings.Ports['8080/tcp'][0].HostPort}`;
  const request = (url, options={}) => fetch(base+url,{...options,signal:AbortSignal.timeout(3000)});
  let health;
  const deadline = performance.now()+30_000;
  while(performance.now()<deadline) {
    try { health=await request('/healthz'); if(health.status===200) break; } catch { /* startup */ }
    await delay(50);
  }
  assert.equal(health?.status,200); assert.deepEqual(await health.json(),{status:'ok',build:sha});
  const startupMs=Math.round(performance.now()-started);
  assert.equal((await state()).counts.stored_responses,3072);
  const spa=await request('/'); assert.equal(spa.status,200); assert.match(await spa.text(),/<html/);
  assert.match(spa.headers.get('content-security-policy')??'',/default-src/);
  const denied=await request('/admin/api/settings/response-retention'); assert.equal(denied.status,401); await denied.arrayBuffer();
  const login=await request('/admin/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password})});
  assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0]; await login.arrayBuffer();
  const apply=async days => {
    const response=await request('/admin/api/settings/response-retention',{method:'PUT',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({days})});
    assert.equal(response.status,200); assert.deepEqual(await response.json(),{days});
  };
  await apply(1); const cleanupStart=performance.now(), healthMs=[], readMs=[], writeMs=[];
  for(let i=0;i<64;i++) {
    let start=performance.now(); const response=await request('/healthz'); assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{status:'ok',build:sha}); healthMs.push(performance.now()-start);
    if(i%8===0) {
      start=performance.now(); const settings=await request('/admin/api/settings/response-retention',{headers:{cookie}});
      assert.equal(settings.status,200); assert.deepEqual(await settings.json(),{days:1}); readMs.push(performance.now()-start);
      start=performance.now(); const created=await request('/v1/conversations',{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'});
      assert.equal(created.status,200); await created.arrayBuffer(); writeMs.push(performance.now()-start); }
    await delay(5);
  }
  let actual;
  for(let i=0;i<30;i++) { actual=await state(); if(actual.counts.stored_responses===2048&&actual.counts.response_conversations===8) break; await apply(1); await delay(100); }
  assert.deepEqual(actual.counts,{stored_responses:2048,response_events:0,response_conversations:8,conversation_items:0});
  assert.equal(actual.configuration,'preserve-config'); assert.equal(actual.imageCache,'preserve-image'); assert.deepEqual(actual.foreignKeys,[]);
  const cleanupMs=Math.round(performance.now()-cleanupStart);
  await apply(0); assert.equal((await state()).setting,'0');
  const records=(await docker(['logs',name])).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  assert(!records.some(record=>record.stage==='responses.prune'));
  const maintenance=records.filter(record=>record.msg==='response retention completed');
  assert.equal(maintenance.reduce((n,r)=>n+r.responses,0),1024); assert.equal(maintenance.reduce((n,r)=>n+r.conversations,0),100);
  const shutdownStart=performance.now(); await docker(['stop','--time','5',name]);
  const stopped=JSON.parse(await docker(['inspect',name]))[0]; assert.equal(stopped.State.ExitCode,0); assert.equal(stopped.State.OOMKilled,false);
  const stat=values=>({samples:values.length,maximumMs:Math.round(Math.max(...values)*100)/100});
  console.log(JSON.stringify({image,commit:sha,version,platform:'linux/amd64 (Docker Desktop on Darwin arm64)',
    resourceLimits:{cpus:1,memoryMiB:256,javaScriptHeapMiB:128,pids:96},...seeded,startupMs,cleanupMs,
    health:stat(healthMs),databaseReads:stat(readMs),databaseWrites:stat(writeMs),actual:actual.counts,configurationPreserved:true,imageCachePreserved:true,
    foreignKeyCheck:'passed',spaCsp:'passed',unauthenticatedAdminStatus:401,zeroRetentionSetting:'passed',
    shutdownMs:Math.round(performance.now()-shutdownStart),gracefulExitCode:stopped.State.ExitCode,
    maintenance:maintenance.map(r=>({responses:r.responses,conversations:r.conversations,scanned:r.scanned,batches:r.batches})),
    limitations:['Synthetic fixture and emulated CPU do not establish production I/O performance','Native calls, active-set scans and cascades can exceed the between-call cycle budget','No production access, deletion or deployment']},null,2));
} catch(error) { failure=error; throw error; }
finally {
  const errors=[];
  for(const containerName of [name,seedName])
    await docker(['rm','--force',containerName]).catch(error=>{if(!String(error.stderr).includes('No such container')) errors.push(containerName);});
  await docker(['volume','rm',volume]).catch(error=>{if(!String(error.stderr).includes('no such volume')) errors.push(volume);});
  if(errors.length) { console.error('Disposable smoke cleanup failed: '+errors.join(', ')); if(!failure) throw new Error('Disposable smoke cleanup failed'); }
}
