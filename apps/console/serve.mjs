// The console's own server: serves the built dashboard and forwards the API
// paths to the gateway named by BACKEND_URL. From the browser's point of view
// the dashboard and the API share one origin, so the session cookie keeps
// working and no CORS is involved -- the console container can sit on a
// hostname of its own with the gateway reachable only on an internal network.
//
//   BACKEND_URL   where the gateway lives, e.g. http://gateway:8080 (required)
//   PORT          port to listen on (default 8080)
//   HOST          bind address (default 0.0.0.0)
//   DIST_DIR      the built dashboard (default ./dist beside this file)
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.env.DIST_DIR ?? path.join(here, "dist"));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const BACKEND = process.env.BACKEND_URL;
if (!BACKEND) {
  console.error("BACKEND_URL is required (the gateway this console talks to, e.g. http://gateway:8080)");
  process.exit(1);
}
const backend = new URL(BACKEND);
const agent = backend.protocol === "https:" ? https : http;

/** Request paths handed to the gateway untouched. */
const FORWARDED = ["/admin/api", "/v1", "/healthz"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function forward(req, res) {
  const headers = { ...req.headers, host: backend.host };
  // Tell the gateway which scheme the browser used, so its cookie Secure flag
  // (COOKIE_SECURE=auto) follows the console's own TLS termination.
  if (!headers["x-forwarded-proto"]) headers["x-forwarded-proto"] = req.socket.encrypted ? "https" : "http";
  const upstream = agent.request(
    { protocol: backend.protocol, hostname: backend.hostname, port: backend.port || undefined, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res); // streamed, so SSE and long JSON heartbeats flow through as they arrive
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `gateway unreachable at ${backend.origin}: ${err.message}` }));
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://console");
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html"); // SPA fallback
  const ext = path.extname(file);
  const immutable = url.pathname.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  if (FORWARDED.some((p) => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?"))) return forward(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    return res.end();
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`console listening on http://${HOST}:${PORT}, forwarding ${FORWARDED.join(", ")} to ${backend.origin}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
