/**
 * Environment parsing (`loadConfig`).
 *
 * Several of these settings have security weight (TRUST_PROXY decides whose
 * X-Forwarded-For is believed; ALLOW_PRIVATE_UPSTREAMS opens the SSRF guard),
 * and each has a small grammar with boundaries that are easy to move by
 * accident. Secrets are supplied explicitly except where their generation is
 * the subject, so nothing here depends on process.env.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config";

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-config-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const MASTER_KEY = Buffer.alloc(32, 7);
const SESSION = "s".repeat(16);

/** A valid environment, with overrides; `undefined` removes a variable. */
function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    DATA_DIR: tmpDir(),
    PROXY_MASTER_KEY: MASTER_KEY.toString("base64"),
    SESSION_SECRET: SESSION,
    ...over,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return base as NodeJS.ProcessEnv;
}

describe("defaults", () => {
  it("an environment with only the secrets set gets the documented defaults", () => {
    const e = env();
    expect(loadConfig(e)).toMatchObject({
      nodeEnv: "production",
      isProduction: true,
      port: 8080,
      host: "0.0.0.0",
      dataDir: e.DATA_DIR,
      admin: { username: "admin", password: "" },
      sessionTtlMs: 12 * 3_600_000,
      logPayloadMaxChars: 100_000,
      cookieSecure: "auto",
      allowPrivateUpstreams: false,
      trustProxy: false,
      simulatedStreamingTokenRate: 2000,
      streamCommitGraceMs: 2_500,
      streamPingIntervalMs: 10_000,
      imageCacheMaxBytes: 64 * 1024 * 1024,
      jsonCommitGraceMs: 30_000,
      updateRestartEnabled: false,
    });
  });

  it("NODE_ENV other than production clears isProduction; an unknown value is refused", () => {
    expect(loadConfig(env({ NODE_ENV: "test" })).isProduction).toBe(false);
    expect(() => loadConfig(env({ NODE_ENV: "staging" }))).toThrow(/Invalid environment configuration:\n\s+- NODE_ENV/);
  });
});

describe("EP: TRUST_PROXY", () => {
  it.each(["", "false", "0", "off", "no", " FALSE "])("%j trusts nothing", (v) => {
    expect(loadConfig(env({ TRUST_PROXY: v })).trustProxy).toBe(false);
  });

  it.each(["true", "1", "YES", "on", " On "])("%j trusts every hop", (v) => {
    expect(loadConfig(env({ TRUST_PROXY: v })).trustProxy).toBe(true);
  });

  it("a number above 1 is a hop count (note: 1 itself means `true`, not one hop)", () => {
    expect(loadConfig(env({ TRUST_PROXY: "2" })).trustProxy).toBe(2);
    expect(loadConfig(env({ TRUST_PROXY: "10" })).trustProxy).toBe(10);
  });

  it.each(["-1", "1.5", "maybe", "2 hops"])("%j stops the boot", (v) => {
    expect(() => loadConfig(env({ TRUST_PROXY: v }))).toThrow(`Invalid TRUST_PROXY: "${v}"`);
  });
});

describe("EP: ALLOW_PRIVATE_UPSTREAMS", () => {
  it.each(["1", "TRUE", " on ", "yes"])("%j opens private upstreams", (v) => {
    expect(loadConfig(env({ ALLOW_PRIVATE_UPSTREAMS: v })).allowPrivateUpstreams).toBe(true);
  });

  it.each(["0", "false", "enabled", "", "2"])("%j leaves them blocked", (v) => {
    expect(loadConfig(env({ ALLOW_PRIVATE_UPSTREAMS: v })).allowPrivateUpstreams).toBe(false);
  });

  it("unset leaves them blocked", () => {
    expect(loadConfig(env()).allowPrivateUpstreams).toBe(false);
  });
});

describe("BVA: keep-alive windows", () => {
  it("STREAM_COMMIT_GRACE_MS must be positive: 0 is refused, 1 is accepted", () => {
    expect(() => loadConfig(env({ STREAM_COMMIT_GRACE_MS: "0" }))).toThrow(/STREAM_COMMIT_GRACE_MS/);
    expect(loadConfig(env({ STREAM_COMMIT_GRACE_MS: "1" })).streamCommitGraceMs).toBe(1);
  });

  it("JSON_COMMIT_GRACE_MS may be 0 (guard off) but not negative", () => {
    expect(loadConfig(env({ JSON_COMMIT_GRACE_MS: "0" })).jsonCommitGraceMs).toBe(0);
    expect(() => loadConfig(env({ JSON_COMMIT_GRACE_MS: "-1" }))).toThrow(/JSON_COMMIT_GRACE_MS/);
  });

  it("STREAM_PING_INTERVAL_MS must be a positive integer", () => {
    expect(() => loadConfig(env({ STREAM_PING_INTERVAL_MS: "0" }))).toThrow(/STREAM_PING_INTERVAL_MS/);
    expect(() => loadConfig(env({ STREAM_PING_INTERVAL_MS: "1.5" }))).toThrow(/STREAM_PING_INTERVAL_MS/);
    expect(loadConfig(env({ STREAM_PING_INTERVAL_MS: "250" })).streamPingIntervalMs).toBe(250);
  });

  it("IMAGE_CACHE_MAX_BYTES may be 0 (cache off) but not negative", () => {
    expect(loadConfig(env({ IMAGE_CACHE_MAX_BYTES: "0" })).imageCacheMaxBytes).toBe(0);
    expect(() => loadConfig(env({ IMAGE_CACHE_MAX_BYTES: "-1" }))).toThrow(/IMAGE_CACHE_MAX_BYTES/);
  });

  it("PORT must be a positive integer", () => {
    expect(loadConfig(env({ PORT: "3000" })).port).toBe(3000);
    expect(() => loadConfig(env({ PORT: "0" }))).toThrow(/PORT/);
    expect(() => loadConfig(env({ PORT: "http" }))).toThrow(/PORT/);
  });
});

describe("EP: SESSION_TTL durations", () => {
  it.each([
    ["45s", 45_000],
    ["30m", 1_800_000],
    ["12h", 43_200_000],
    ["7d", 604_800_000],
    ["250ms", 250],
    ["500", 500], // a bare number is milliseconds
    [" 2 h ", 7_200_000],
    ["0", 0],
  ])("%j -> %d ms", (input, ms) => {
    expect(loadConfig(env({ SESSION_TTL: input })).sessionTtlMs).toBe(ms);
  });

  it.each(["1.5h", "abc", "-5m", "5w", ""])("%j stops the boot", (input) => {
    expect(() => loadConfig(env({ SESSION_TTL: input }))).toThrow(`Invalid duration: "${input}"`);
  });
});

describe("BVA: SESSION_SECRET length", () => {
  it("15 characters is refused, 16 is accepted", () => {
    expect(() => loadConfig(env({ SESSION_SECRET: "x".repeat(15) }))).toThrow("SESSION_SECRET must be at least 16 characters.");
    expect(loadConfig(env({ SESSION_SECRET: "x".repeat(16) })).sessionSecret).toBe("x".repeat(16));
  });

  it("the length is measured after trimming", () => {
    expect(() => loadConfig(env({ SESSION_SECRET: `  ${"x".repeat(15)}  ` }))).toThrow(/at least 16 characters/);
    expect(loadConfig(env({ SESSION_SECRET: `  ${"x".repeat(16)}  ` })).sessionSecret).toBe("x".repeat(16));
  });
});

describe("EP: PROXY_MASTER_KEY encodings", () => {
  it("44-character base64 decodes to the 32-byte key", () => {
    const raw = MASTER_KEY.toString("base64");
    expect(raw).toHaveLength(44);
    expect(loadConfig(env({ PROXY_MASTER_KEY: raw })).masterKey.equals(MASTER_KEY)).toBe(true);
  });

  it("64-character hex decodes to the same 32-byte key, in either case", () => {
    const hex = MASTER_KEY.toString("hex");
    expect(hex).toHaveLength(64);
    expect(loadConfig(env({ PROXY_MASTER_KEY: hex })).masterKey.equals(MASTER_KEY)).toBe(true);
    const mixed = Buffer.from("ab".repeat(32), "hex");
    expect(loadConfig(env({ PROXY_MASTER_KEY: "AB".repeat(32) })).masterKey.equals(mixed)).toBe(true);
  });

  it.each([
    ["31 bytes of base64", Buffer.alloc(31, 7).toString("base64")],
    ["33 bytes of base64", Buffer.alloc(33, 7).toString("base64")],
    ["62 hex characters", "ab".repeat(31)],
    ["a passphrase", "correct horse battery staple"],
  ])("%s is refused", (_what, raw) => {
    expect(() => loadConfig(env({ PROXY_MASTER_KEY: raw }))).toThrow(/PROXY_MASTER_KEY must be a 32-byte key/);
  });
});

describe("ST: secrets left blank are generated once and then reused", () => {
  it("generates both, persists them owner-only, and returns the same values on the next boot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dataDir = path.join(tmpDir(), "nested", "data"); // created on demand
    const blank = { DATA_DIR: dataDir, PROXY_MASTER_KEY: "", SESSION_SECRET: "   " };

    const first = loadConfig(blank);
    expect(first.masterKey).toHaveLength(32);
    expect(first.sessionSecret.length).toBeGreaterThanOrEqual(16);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("auto-generated PROXY_MASTER_KEY and SESSION_SECRET");

    const file = path.join(dataDir, "hydrogen-secrets.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { masterKey: string; sessionSecret: string };
    expect(Buffer.from(stored.masterKey, "base64").equals(first.masterKey)).toBe(true);
    expect(stored.sessionSecret).toBe(first.sessionSecret);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const second = loadConfig(blank);
    expect(second.masterKey.equals(first.masterKey)).toBe(true);
    expect(second.sessionSecret).toBe(first.sessionSecret);
    expect(warn).toHaveBeenCalledTimes(1); // nothing new was generated
  });

  it("an environment value wins over a persisted one, and is not written back", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dataDir = tmpDir();
    const generated = loadConfig({ DATA_DIR: dataDir });
    const explicit = crypto.randomBytes(32);

    const cfg = loadConfig({ DATA_DIR: dataDir, PROXY_MASTER_KEY: explicit.toString("base64"), SESSION_SECRET: SESSION });
    expect(cfg.masterKey.equals(explicit)).toBe(true);
    expect(cfg.sessionSecret).toBe(SESSION);

    const again = loadConfig({ DATA_DIR: dataDir });
    expect(again.masterKey.equals(generated.masterKey)).toBe(true);
    expect(again.sessionSecret).toBe(generated.sessionSecret);
  });

  it("only the missing secret is generated when the other is supplied", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dataDir = tmpDir();
    const cfg = loadConfig({ DATA_DIR: dataDir, SESSION_SECRET: SESSION });
    expect(cfg.sessionSecret).toBe(SESSION);
    expect(String(warn.mock.calls[0][0])).toContain("auto-generated PROXY_MASTER_KEY and stored");
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "hydrogen-secrets.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(stored)).toEqual(["masterKey"]);
  });
});
