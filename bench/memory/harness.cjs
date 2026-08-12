/**
 * Memory sweep for the Hydrogen proxy.
 *
 * Holds the traffic fixed and varies only Micro Agent stage count, which is the
 * axis the user's report points at ("gradually worse since Micro Agent came
 * in"). Reports peak RSS during load and retained RSS after a forced GC, so a
 * high peak can be told apart from a genuine retention.
 *
 * Everything runs against a local mock upstream. Nothing touches production.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = process.env.REPO || path.resolve(__dirname, "../..");
const BUNDLE = process.env.BUNDLE || path.join(REPO, "server/dist/server.cjs");
const HERE = __dirname;

const PORT = 8790;
const MOCK_PORT = 8791;
const GC_PORT = 8792;
const ADMIN_PW = "measure-admin-pw";
const CONV_BYTES = Number(process.env.CONV_BYTES || 85_000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);
const ROUNDS = Number(process.env.ROUNDS || 5);

const MB = (n) => (n / (1024 * 1024)).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- process management -----------------------------------------------------

const children = [];
function spawnChild(label, args, env, cwd) {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, cwd, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${label}] ${d}`));
  p.stderr.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${label}!] ${d}`));
  children.push(p);
  return p;
}
function killAll() {
  for (const p of children) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
}
process.on("exit", killAll);

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await sleep(200);
  }
}

// --- admin API --------------------------------------------------------------

const base = `http://127.0.0.1:${PORT}`;
let cookie = "";

async function api(method, urlPath, body) {
  const r = await fetch(`${base}/admin/api${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!r.ok) throw new Error(`${method} ${urlPath} -> ${r.status} ${text.slice(0, 300)}`);
  return { json, headers: r.headers };
}

async function login() {
  const r = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PW }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
  cookie = raw.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("login returned no cookie");
}

const plainSteps = () => ({ timeoutMs: 60_000, steps: [{ model: "mock-model", provider: "mock" }] });

const agentDef = (stageCount) => ({
  kind: "micro_agent",
  timeoutMs: 120_000,
  stages: Array.from({ length: stageCount }, (_, i) => ({
    name: `s${i + 1}`,
    steps: [{ model: "mock-model", provider: "mock" }],
    input: [], // [] = pass the original conversation through, the common case
  })),
});

async function seed() {
  await login();
  await api("POST", "/providers", {
    name: "mock",
    type: "openai_completion",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    apiKey: "test-key",
    extraHeaders: {},
  });
  const model = (await api("POST", "/models", { name: "mock-model", description: null })).json.model;
  const providers = (await api("GET", "/providers")).json.providers;
  await api("POST", "/mappings", { modelId: model.id, providerId: providers[0].id, upstreamModel: "mock-upstream-model" });

  await api("POST", "/services", { name: "plain", steps: plainSteps() });
  for (const n of [1, 3, 5]) {
    await api("POST", "/services", { name: `agent${n}`, steps: agentDef(n) });
  }
  const tok = await api("POST", "/tokens", { name: "measure" });
  return tok.json.secret;
}

// --- load -------------------------------------------------------------------

function conversation(targetBytes) {
  const filler = "The quick brown fox jumps over the lazy dog. ".repeat(45); // ~2 KB
  const messages = [{ role: "system", content: "You are a helpful assistant." }];
  let bytes = 0;
  let turn = 0;
  while (bytes < targetBytes) {
    const role = turn % 2 === 0 ? "user" : "assistant";
    const content = `${filler}[turn ${turn}]`;
    messages.push({ role, content });
    bytes += Buffer.byteLength(content);
    turn++;
  }
  if (messages[messages.length - 1].role === "assistant") {
    messages.push({ role: "user", content: "Given all of the above, answer briefly." });
  }
  return messages;
}

async function fire(secret, service, messages, stream) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: service, messages, stream, max_tokens: 256 }),
  });
  // Drain fully: an unread stream would leave the proxy holding it.
  const text = await r.text();
  return { status: r.status, bytes: Buffer.byteLength(text) };
}

// --- measurement ------------------------------------------------------------

function readSamples(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function windowStats(samples, from, to) {
  const inWindow = samples.filter((s) => s.at >= from && s.at <= to);
  if (!inWindow.length) return null;
  const peak = (k) => Math.max(...inWindow.map((s) => s[k]));
  return { peakRss: peak("rss"), peakHeap: peak("heapUsed"), peakExternal: peak("external"), n: inWindow.length };
}

async function forceGc() {
  const r = await fetch(`http://127.0.0.1:${GC_PORT}/`);
  return r.json();
}

async function scenario(memFile, secret, label, service, messages, stream) {
  const start = Date.now();
  let ok = 0;
  let failed = 0;
  const statuses = new Map();
  for (let round = 0; round < ROUNDS; round++) {
    const batch = Array.from({ length: CONCURRENCY }, () =>
      fire(secret, service, messages, stream).then(
        (r) => {
          statuses.set(r.status, (statuses.get(r.status) || 0) + 1);
          if (r.status === 200) ok++;
          else failed++;
        },
        () => {
          failed++;
        },
      ),
    );
    await Promise.all(batch);
  }
  const end = Date.now();
  const load = windowStats(readSamples(memFile), start, end);
  await sleep(3000);
  const gc = await forceGc();
  return {
    label,
    ok,
    failed,
    statuses: [...statuses.entries()].map(([s, n]) => `${s}x${n}`).join(" "),
    peakRss: load ? load.peakRss : 0,
    peakHeap: load ? load.peakHeap : 0,
    peakExternal: load ? load.peakExternal : 0,
    retainedRss: gc.rss,
    retainedHeap: gc.heapUsed,
    ms: end - start,
  };
}

// --- main -------------------------------------------------------------------

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-mem-"));
  const memFile = path.join(dataDir, "mem.jsonl");
  fs.writeFileSync(memFile, "");

  process.stdout.write(`bundle:   ${BUNDLE}\ndata dir: ${dataDir}\n`);
  process.stdout.write(`conversation ${(CONV_BYTES / 1024).toFixed(0)} KB, concurrency ${CONCURRENCY}, ${ROUNDS} rounds\n\n`);

  spawnChild(
    "mock",
    [path.join(HERE, "mock-upstream.cjs")],
    {
      MOCK_PORT: String(MOCK_PORT),
      RESP_CHARS: "2000",
      MOCK_DELAY_MS: process.env.MOCK_DELAY_MS || "0",
      MOCK_FRAME_DELAY_MS: process.env.MOCK_FRAME_DELAY_MS || "0",
    },
    HERE,
  );
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/__stats`);

  spawnChild(
    "server",
    ["--expose-gc", path.join(HERE, "boot.cjs")],
    {
      SERVER_BUNDLE: BUNDLE,
      MEM_OUT: memFile,
      GC_PORT: String(GC_PORT),
      PORT: String(PORT),
      DATA_DIR: dataDir,
      NODE_ENV: "production",
      // The mock upstream is on loopback, which the SSRF guard blocks by default.
      ALLOW_PRIVATE_UPSTREAMS: "true",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: ADMIN_PW,
      PROXY_MASTER_KEY: "0".repeat(64),
      SESSION_SECRET: "measurement-session-secret-value",
      // 100000 is the product default. 0 = unlimited, which skips the
      // truncate-and-restringify loop in serializeForLog entirely.
      LOG_PAYLOAD_MAX_CHARS: process.env.LPMC || "100000",
    },
    REPO,
  );
  await waitFor(`${base}/healthz`);

  const idleGc = await forceGc();
  process.stdout.write(`idle after boot: rss ${MB(idleGc.rss)} MB, heap ${MB(idleGc.heapUsed)} MB (gc ${idleGc.gcAvailable})\n\n`);

  const secret = await seed();
  const messages = conversation(CONV_BYTES);
  const reqBytes = Buffer.byteLength(JSON.stringify({ model: "x", messages, stream: false, max_tokens: 256 }));
  process.stdout.write(`request body: ${(reqBytes / 1024).toFixed(1)} KB, ${messages.length} messages\n\n`);

  const allScenarios = [
    ["plain          non-stream", "plain", false],
    ["agent 1 stage  non-stream", "agent1", false],
    ["agent 3 stages non-stream", "agent3", false],
    ["agent 5 stages non-stream", "agent5", false],
    ["plain          streaming ", "plain", true],
    ["agent 5 stages streaming ", "agent5", true],
  ];
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  const scenarios = only ? allScenarios.filter(([, svc]) => only.includes(svc)) : allScenarios;

  const results = [];
  for (const [label, service, stream] of scenarios) {
    const r = await scenario(memFile, secret, label, service, messages, stream);
    results.push(r);
    process.stdout.write(
      `${label}  ok=${String(r.ok).padStart(3)} fail=${String(r.failed).padStart(3)}  ` +
        `peakRSS ${MB(r.peakRss).padStart(7)} MB  peakHeap ${MB(r.peakHeap).padStart(7)} MB  ` +
        `retainedRSS ${MB(r.retainedRss).padStart(7)} MB  ${r.ms}ms  ${r.statuses}\n`,
    );
  }

  const mock = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__stats`)).json();
  process.stdout.write(`\nupstream calls: ${mock.calls}, bytes received: ${MB(mock.bytesIn)} MB\n`);

  // Alongside the samples, in the throwaway data dir — never into the repo.
  const resultsPath = path.join(dataDir, "results.json");
  fs.writeFileSync(
    resultsPath,
    JSON.stringify({ bundle: BUNDLE, convBytes: CONV_BYTES, concurrency: CONCURRENCY, rounds: ROUNDS, reqBytes, results }, null, 2),
  );
  process.stdout.write(`\nwrote ${resultsPath}\nmem samples: ${memFile}\n`);
  killAll();
  process.exit(0);
})().catch((e) => {
  process.stdout.write(`\nFAILED: ${e.stack || e.message}\n`);
  killAll();
  process.exit(1);
});
