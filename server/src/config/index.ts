import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_IMAGE_CACHE_MAX_BYTES,
  DEFAULT_JSON_COMMIT_GRACE_MS,
  DEFAULT_LOG_PAYLOAD_MAX_CHARS,
  DEFAULT_SESSION_TTL,
  DEFAULT_SIMULATED_STREAMING_TOKEN_RATE,
  DEFAULT_STREAM_COMMIT_GRACE_MS,
  DEFAULT_STREAM_PING_INTERVAL_MS,
} from "./defaults";
import { AES_256_KEY_BYTES } from "../security/crypto";
import { formatZodIssues } from "../util/validate";
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from "../util/time";

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_DATA_DIR = "./data";
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_UPDATE_REPO = "Arrosam/Hydrogen-LLM-proxy";

/** Boolean env spellings that mean "on" (case-insensitive). */
const TRUTHY_ENV_PATTERN = /^(1|true|yes|on)$/i;
/** TRUST_PROXY spellings, tested against the trimmed, lower-cased value. */
const TRUST_PROXY_TRUE_PATTERN = /^(1|true|yes|on)$/;
const TRUST_PROXY_FALSE_PATTERN = /^(|0|false|no|off)$/;
const TRUST_PROXY_HOPS_PATTERN = /^\d+$/;

const MASTER_KEY_BYTES = AES_256_KEY_BYTES;
/** A hex-encoded master key: two hex digits per key byte. */
const MASTER_KEY_HEX_PATTERN = new RegExp(`^[0-9a-fA-F]{${MASTER_KEY_BYTES * 2}}$`);
const SESSION_SECRET_BYTES = 48;
const MIN_SESSION_SECRET_CHARS = 16;
/** Owner read/write only. */
const SECRETS_FILE_MODE = 0o600;

/**
 * Parse a human duration like "12h", "30m", "45s", "7d" into milliseconds.
 * Falls back to treating a bare number as milliseconds.
 */
function parseDuration(input: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid duration: "${input}"`);
  const value = Number(m[1]);
  const unit = m[2] ?? "ms";
  const factor: Record<string, number> = {
    ms: 1,
    s: MS_PER_SECOND,
    m: MS_PER_MINUTE,
    h: MS_PER_HOUR,
    d: MS_PER_DAY,
  };
  return value * factor[unit];
}

/**
 * Parse the TRUST_PROXY setting into Fastify's `trustProxy` value.
 * "true"/"1"/"yes"/"on" -> true (trust every hop: safe ONLY behind a reverse
 * proxy the operator controls). "false"/"0"/"no"/"off"/"" -> false (trust
 * nothing: req.ip is the socket address). A positive integer -> that many
 * trusted proxy hops. Anything else is a boot-stopping configuration error:
 * a silent fallback would hide a misconfiguration with security impact.
 */
function parseTrustProxy(raw: string): boolean | number {
  const s = raw.trim().toLowerCase();
  if (TRUST_PROXY_TRUE_PATTERN.test(s)) return true;
  if (TRUST_PROXY_FALSE_PATTERN.test(s)) return false;
  if (TRUST_PROXY_HOPS_PATTERN.test(s)) {
    const n = Number(s);
    if (n >= 1 && Number.isInteger(n)) return n;
  }
  throw new Error(
    `Invalid TRUST_PROXY: "${raw}". Use "false" when the port is exposed directly (default), ` +
      `"true" or a hop count (e.g. "1") when behind a reverse proxy you control.`,
  );
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
  HOST: z.string().default(DEFAULT_HOST),
  DATA_DIR: z.string().default(DEFAULT_DATA_DIR),

  // Whether (and how far) to honour X-Forwarded-* headers. "false" (default)
  // trusts nothing, which is the safe setting when the port is exposed
  // directly (the default docker-compose flow): a spoofed X-Forwarded-For
  // would otherwise rotate the rate-limit key and defeat the login limiter.
  // Behind a reverse proxy, set "true" or a hop count.
  TRUST_PROXY: z.string().optional().default("false"),

  // Both may be left blank: they are auto-generated and persisted on first boot.
  PROXY_MASTER_KEY: z.string().optional().default(""),
  SESSION_SECRET: z.string().optional().default(""),

  ADMIN_USERNAME: z.string().min(1).default(DEFAULT_ADMIN_USERNAME),
  // Blank: a temporary password is generated and printed on first boot.
  ADMIN_PASSWORD: z.string().optional().default(""),

  SESSION_TTL: z.string().default(DEFAULT_SESSION_TTL),
  LOG_PAYLOAD_MAX_CHARS: z.coerce.number().int().nonnegative().default(DEFAULT_LOG_PAYLOAD_MAX_CHARS),
  // Session cookie Secure flag: "auto" = set only on HTTPS requests (via
  // X-Forwarded-Proto). Use "false" behind a plain-HTTP proxy, "true" to force.
  COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
  // SSRF guard: by default upstream provider URLs may not resolve to private,
  // loopback, or link-local addresses. Set to a truthy value to permit local
  // upstreams (e.g. a LAN model server or Ollama at 127.0.0.1). Link-local/
  // metadata addresses (169.254.0.0/16) stay blocked regardless. Accepts the
  // usual boolean spellings (1/true/yes/on) so a common "=1" doesn't crash boot.
  ALLOW_PRIVATE_UPSTREAMS: z
    .string()
    .optional()
    .default("false")
    .transform((v) => TRUTHY_ENV_PATTERN.test(v.trim())),
  // Simulated streaming token rate (tokens/second) used when Reliable Streaming
  // is enabled. The proxy buffers the complete upstream response, then replays
  // it as a paced SSE stream at this rate. Default 2000 tok/s.
  SIMULATED_STREAMING_TOKEN_RATE: z.coerce.number().int().positive().default(DEFAULT_SIMULATED_STREAMING_TOKEN_RATE),
  // Dead-air guard for streaming requests. A buffering executor (Micro Agent,
  // Reliable Streaming) or a slow upstream first token can be silent for
  // minutes, and intermediaries kill silent connections long before that. If a
  // streaming request produces no outcome within the grace window, the proxy
  // commits the SSE response and emits keep-alive pings until it has one; a
  // failure after that point is delivered as the protocol's in-stream error
  // event. Failures faster than the grace window keep their real HTTP status.
  STREAM_COMMIT_GRACE_MS: z.coerce.number().int().positive().default(DEFAULT_STREAM_COMMIT_GRACE_MS),
  STREAM_PING_INTERVAL_MS: z.coerce.number().int().positive().default(DEFAULT_STREAM_PING_INTERVAL_MS),
  // Storage budget for the OCR image-description cache, in bytes. A Micro Agent
  // that runs an image-translation pre-pass remembers each image's description
  // by content hash and skips the model on a repeat; when the budget is
  // exceeded, least-recently-used entries are evicted to make room. 0 turns the
  // cache off. Default 64 MiB. Overridable at runtime from the dashboard.
  IMAGE_CACHE_MAX_BYTES: z.coerce.number().int().nonnegative().default(DEFAULT_IMAGE_CACHE_MAX_BYTES),
  // Dead-air guard for NON-streaming chat requests (OCR/vision answers can
  // take minutes; Cloudflare kills a silent origin at ~100s with a 524). If a
  // JSON response has produced no outcome within this window, the proxy
  // commits 200 and emits whitespace heartbeats into the body until the real
  // JSON follows -- leading whitespace is valid JSON, the same technique
  // Anthropic's own API uses for long non-streaming requests. A failure after
  // that point is delivered as an error JSON body on the committed 200 (the
  // log keeps the semantic status). 0 disables the guard entirely.
  JSON_COMMIT_GRACE_MS: z.coerce.number().int().nonnegative().default(DEFAULT_JSON_COMMIT_GRACE_MS),
  // GitHub repo ("owner/name") the Settings page checks for new releases.
  // Point a fork at itself so its own tags drive the update banner.
  UPDATE_REPO: z
    .string()
    .default(DEFAULT_UPDATE_REPO)
    .refine((v) => /^[\w.-]+\/[\w.-]+$/.test(v), "UPDATE_REPO must be owner/name"),
  // Remote restart is deliberately opt-in. Enabling it asserts that an
  // external supervisor will both restart the process and deploy the intended
  // image/version; a bare Node process and a normal Docker restart cannot.
  UPDATE_RESTART_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => TRUTHY_ENV_PATTERN.test(v.trim())),
});


export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  isProduction: boolean;
  port: number;
  host: string;
  dataDir: string;
  masterKey: Buffer;
  sessionSecret: string;
  admin: { username: string; password: string };
  sessionTtlMs: number;
  logPayloadMaxChars: number;
  cookieSecure: "auto" | "true" | "false";
  allowPrivateUpstreams: boolean;
  /** Fastify trustProxy: false (direct exposure), true (every hop), or a hop count. */
  trustProxy: boolean | number;
  simulatedStreamingTokenRate: number;
  streamCommitGraceMs: number;
  streamPingIntervalMs: number;
  imageCacheMaxBytes: number;
  jsonCommitGraceMs: number;
  updateRepo: string;
  updateRestartEnabled: boolean;
}

/**
 * Validate and normalise process.env into a typed AppConfig.
 * Throws with a readable message when required secrets are missing or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${formatZodIssues(parsed.error.issues, "\n", "  - ")}`);
  }
  const e = parsed.data;

  const { masterKey, sessionSecret } = resolveSecrets(e.DATA_DIR, e.PROXY_MASTER_KEY, e.SESSION_SECRET);

  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === "production",
    port: e.PORT,
    host: e.HOST,
    dataDir: e.DATA_DIR,
    masterKey,
    sessionSecret,
    admin: { username: e.ADMIN_USERNAME, password: e.ADMIN_PASSWORD },
    sessionTtlMs: parseDuration(e.SESSION_TTL),
    logPayloadMaxChars: e.LOG_PAYLOAD_MAX_CHARS,
    cookieSecure: e.COOKIE_SECURE,
    allowPrivateUpstreams: e.ALLOW_PRIVATE_UPSTREAMS,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    simulatedStreamingTokenRate: e.SIMULATED_STREAMING_TOKEN_RATE,
    streamCommitGraceMs: e.STREAM_COMMIT_GRACE_MS,
    streamPingIntervalMs: e.STREAM_PING_INTERVAL_MS,
    imageCacheMaxBytes: e.IMAGE_CACHE_MAX_BYTES,
    jsonCommitGraceMs: e.JSON_COMMIT_GRACE_MS,
    updateRepo: e.UPDATE_REPO,
    updateRestartEnabled: e.UPDATE_RESTART_ENABLED,
  };
}

/**
 * The master key must decode to exactly 32 bytes for AES-256-GCM.
 * Accepts base64 (preferred) or hex.
 */
function decodeMasterKey(raw: string): Buffer {
  let key: Buffer | null = null;
  // Try base64 first. (Buffer.from never throws on a string: characters that
  // are not base64 are skipped, so a wrong value shows up as a wrong length.)
  const b = Buffer.from(raw, "base64");
  if (b.length === MASTER_KEY_BYTES) key = b;
  // Then hex.
  if (!key && MASTER_KEY_HEX_PATTERN.test(raw)) {
    key = Buffer.from(raw, "hex");
  }
  if (!key) {
    throw new Error(
      "PROXY_MASTER_KEY must be a 32-byte key encoded as base64 (44 chars) or hex (64 chars). " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Secret resolution: use env values when present, otherwise auto-generate and
// persist them so they survive restarts (the master key MUST be stable, or
// stored provider keys become undecryptable).
// ---------------------------------------------------------------------------

interface StoredSecrets {
  masterKey?: string; // base64, 32 bytes
  sessionSecret?: string;
}

function secretsPath(dataDir: string): string {
  return path.join(dataDir, "hydrogen-secrets.json");
}

function readStoredSecrets(dataDir: string): StoredSecrets {
  try {
    return JSON.parse(fs.readFileSync(secretsPath(dataDir), "utf8")) as StoredSecrets;
  } catch {
    return {};
  }
}

function writeStoredSecrets(dataDir: string, secrets: StoredSecrets): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = secretsPath(dataDir);
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: SECRETS_FILE_MODE });
  try {
    fs.chmodSync(file, SECRETS_FILE_MODE); // best-effort; a no-op on Windows
  } catch {
    /* ignore */
  }
}

function resolveSecrets(
  dataDir: string,
  envMasterKey: string,
  envSessionSecret: string,
): { masterKey: Buffer; sessionSecret: string } {
  const stored = readStoredSecrets(dataDir);
  let dirty = false;
  const generated: string[] = [];

  // Master key: env > persisted > generate.
  let masterKey: Buffer;
  if (envMasterKey.trim()) {
    masterKey = decodeMasterKey(envMasterKey.trim());
  } else if (stored.masterKey) {
    masterKey = decodeMasterKey(stored.masterKey);
  } else {
    masterKey = crypto.randomBytes(MASTER_KEY_BYTES);
    stored.masterKey = masterKey.toString("base64");
    dirty = true;
    generated.push("PROXY_MASTER_KEY");
  }

  // Session secret: env > persisted > generate.
  let sessionSecret: string;
  if (envSessionSecret.trim()) {
    if (envSessionSecret.trim().length < MIN_SESSION_SECRET_CHARS) {
      throw new Error("SESSION_SECRET must be at least 16 characters.");
    }
    sessionSecret = envSessionSecret.trim();
  } else if (stored.sessionSecret) {
    sessionSecret = stored.sessionSecret;
  } else {
    sessionSecret = crypto.randomBytes(SESSION_SECRET_BYTES).toString("base64");
    stored.sessionSecret = sessionSecret;
    dirty = true;
    generated.push("SESSION_SECRET");
  }

  if (dirty) writeStoredSecrets(dataDir, stored);
  if (generated.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] auto-generated ${generated.join(" and ")} and stored them in ` +
        `${secretsPath(dataDir)} (persisted with the data). For stronger security, ` +
        `set them via environment variables instead.`,
    );
  }

  return { masterKey, sessionSecret };
}
