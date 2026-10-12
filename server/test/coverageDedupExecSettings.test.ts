import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { SettingsRepo } from "../src/persistence/settingsRepo";

// Characterization of the integer settings' edge inputs, which every getter
// reads through `Number(raw)`: what an empty, padded, exponent or hex value
// means, per lower bound.

let dir: string;
let db: DB;
let sqlite: BetterSqlite3.Database;
let settings: SettingsRepo;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-dedup-settings-"));
  ({ db, sqlite } = openDatabase(dir));
  settings = new SettingsRepo(db, { allowPrivate: false, logPayloadMaxChars: 11, simulatedStreamingTokenRate: 22, sessionTtlMs: 33, imageCacheMaxBytes: 44, promptCacheTtlMinutes: 55 });
});
afterEach(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const GETTERS = {
  log_payload_max_chars: () => settings.logPayloadMaxChars(),
  simulated_streaming_token_rate: () => settings.simulatedStreamingTokenRate(),
  prompt_cache_ttl_minutes: () => settings.promptCacheTtlMinutes(),
  image_cache_max_bytes: () => settings.imageCacheMaxBytes(),
  response_retention_days: () => settings.responseRetentionDays(),
} as const;
const read = (key: keyof typeof GETTERS, raw: string): number => {
  settings.set(key, raw);
  return GETTERS[key]();
};

describe("SettingsRepo integer settings: edge inputs", () => {
  it("an empty or blank value is the number zero: valid where zero is, junk where it is not", () => {
    for (const blank of ["", "   "]) {
      expect(read("log_payload_max_chars", blank)).toBe(0);
      expect(read("image_cache_max_bytes", blank)).toBe(0);
      expect(read("response_retention_days", blank)).toBe(0);
      expect(read("simulated_streaming_token_rate", blank)).toBe(22);
      expect(read("prompt_cache_ttl_minutes", blank)).toBe(55);
    }
  });

  it("padding, exponent and hex spellings of an integer are accepted", () => {
    for (const key of Object.keys(GETTERS) as Array<keyof typeof GETTERS>) {
      expect(read(key, " 7 "), key).toBe(7);
      expect(read(key, "1e2"), key).toBe(100);
      expect(read(key, "0x10"), key).toBe(16);
      expect(read(key, "5.0"), key).toBe(5);
    }
  });

  it("NaN, infinities and fractions fall back to each setting's own default", () => {
    const fallback = { log_payload_max_chars: 11, simulated_streaming_token_rate: 22, prompt_cache_ttl_minutes: 55, image_cache_max_bytes: 44, response_retention_days: 30 };
    for (const key of Object.keys(GETTERS) as Array<keyof typeof GETTERS>) {
      for (const junk of ["NaN", "Infinity", "-Infinity", "1.5", "-1", "12abc", "null"]) expect(read(key, junk), `${key}=${junk}`).toBe(fallback[key]);
    }
  });

  it("only response retention has an upper bound", () => {
    expect(read("response_retention_days", "3650")).toBe(3650);
    expect(read("response_retention_days", "3651")).toBe(30);
    for (const key of ["log_payload_max_chars", "simulated_streaming_token_rate", "prompt_cache_ttl_minutes", "image_cache_max_bytes"] as const) {
      expect(read(key, "9007199254740991"), key).toBe(Number.MAX_SAFE_INTEGER);
    }
  });

  it("the session epoch, unlike the others, accepts a fraction", () => {
    settings.set("session_epoch", "12.5");
    expect(settings.sessionEpochMs()).toBe(12.5);
    settings.set("session_epoch", "");
    expect(settings.sessionEpochMs()).toBe(0);
  });
});
