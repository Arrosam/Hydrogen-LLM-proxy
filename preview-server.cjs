// Dev/preview launcher: sets safe defaults then starts the built server bundle.
// NOT for production use (uses a throwaway master key + demo admin).
const os = require("node:os");
const path = require("node:path");

process.env.PROXY_MASTER_KEY ||= Buffer.alloc(32, 7).toString("base64");
process.env.SESSION_SECRET ||= "preview-only-secret-change-me-0123456789";
process.env.DATA_DIR ||= path.join(os.tmpdir(), "hydrogen-preview");
process.env.ADMIN_USERNAME ||= "admin";
process.env.ADMIN_PASSWORD ||= "admin12345";
process.env.NODE_ENV ||= "development";
process.env.PORT ||= "8094";

require("./server/dist/server.cjs");
