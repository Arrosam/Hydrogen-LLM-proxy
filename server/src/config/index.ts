import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

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
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * factor[unit];
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("./data"),

  // Both may be left blank: they are auto-generated and persisted on first boot.
  PROXY_MASTER_KEY: z.string().optional().default(""),
  SESSION_SECRET: z.string().optional().default(""),

  ADMIN_USERNAME: z.string().min(1).default("admin"),
  // Blank: a temporary password is generated and printed on first boot.
  ADMIN_PASSWORD: z.string().optional().default(""),

  SESSION_TTL: z.string().default("12h"),
  LOG_PAYLOAD_MAX_CHARS: z.coerce.number().int().nonnegative().default(100000),
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
    .transform((v) => /^(1|true|yes|on)$/i.test(v.trim())),
  // Simulated streaming token rate (tokens/second) used when Reliable Streaming
  // is enabled. The proxy buffers the complete upstream response, then replays
  // it as a paced SSE stream at this rate. Default 2000 tok/s.
  SIMULATED_STREAMING_TOKEN_RATE: z.coerce.number().int().positive().default(2000),
});

export type RawEnv = z.infer<typeof EnvSchema>;

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
  simulatedStreamingTokenRate: number;
}

/**
 * Validate and normalise process.env into a typed AppConfig.
 * Throws with a readable message when required secrets are missing or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
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
    simulatedStreamingTokenRate: e.SIMULATED_STREAMING_TOKEN_RATE,
  };
}

/**
 * The master key must decode to exactly 32 bytes for AES-256-GCM.
 * Accepts base64 (preferred) or hex.
 */
function decodeMasterKey(raw: string): Buffer {
  let key: Buffer | null = null;
  // Try base64 first.
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) key = b;
  } catch {
    /* ignore */
  }
  // Then hex.
  if (!key && /^[0-9a-fA-F]{64}$/.test(raw)) {
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
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // best-effort; a no-op on Windows
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
    masterKey = crypto.randomBytes(32);
    stored.masterKey = masterKey.toString("base64");
    dirty = true;
    generated.push("PROXY_MASTER_KEY");
  }

  // Session secret: env > persisted > generate.
  let sessionSecret: string;
  if (envSessionSecret.trim()) {
    if (envSessionSecret.trim().length < 16) {
      throw new Error("SESSION_SECRET must be at least 16 characters.");
    }
    sessionSecret = envSessionSecret.trim();
  } else if (stored.sessionSecret) {
    sessionSecret = stored.sessionSecret;
  } else {
    sessionSecret = crypto.randomBytes(48).toString("base64");
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
