/**
 * Boots the built server bundle with an in-process memory sampler.
 *
 * Sampling from inside the process is what makes heapUsed / external /
 * arrayBuffers available; RSS alone cannot tell a JS-object cost from a Buffer
 * cost. No source file is modified — this only wraps the bundle.
 *
 * With --expose-gc and GC_PORT set, a GET to that port forces a full GC and
 * returns memoryUsage(). That is the leak test: whatever survives a forced
 * collection is genuinely retained, not just uncollected garbage.
 */
const fs = require("node:fs");
const http = require("node:http");

const out = process.env.MEM_OUT;
const bundle = process.env.SERVER_BUNDLE;
if (!out || !bundle) {
  throw new Error("MEM_OUT and SERVER_BUNDLE are required");
}

const sample = () => {
  const m = process.memoryUsage();
  return {
    at: Date.now(),
    rss: m.rss,
    heapTotal: m.heapTotal,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
};

const timer = setInterval(() => {
  fs.appendFileSync(out, JSON.stringify(sample()) + "\n");
}, 200);
timer.unref();

if (process.env.GC_PORT) {
  const gcServer = http.createServer((_req, res) => {
    if (global.gc) {
      global.gc();
      global.gc(); // second pass collects what the first made unreachable
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ gcAvailable: Boolean(global.gc), ...sample() }));
  });
  gcServer.listen(Number(process.env.GC_PORT), "127.0.0.1");
  gcServer.unref();
}

require(bundle);
