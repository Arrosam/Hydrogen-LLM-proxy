/**
 * SettingsRepo getters against what can actually be sitting in the table: a
 * value written by an older build, by hand, or restored from a backup. Each
 * getter must answer its default for junk instead of handing the junk on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { parseDurationToMs, SettingsRepo } from "../src/persistence/settingsRepo";

let dir: string;
let sqlite: BetterSqlite3.Database;
let db: DB;
let settings: SettingsRepo;

/** Deliberately not the built-in defaults, so a fallback is distinguishable
 * from a hard-coded number. */
const DEFAULTS = {
  allowPrivate: false,
  logPayloadMaxChars: 1234,
  simulatedStreamingTokenRate: 77,
  sessionTtlMs: 45_000,
  imageCacheMaxBytes: 4096,
  promptCacheTtlMinutes: 9,
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-coverage-settings-"));
  const opened = openDatabase(dir);
  db = opened.db;
  sqlite = opened.sqlite;
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM settings").run();
  settings = new SettingsRepo(db, DEFAULTS);
});

describe("parseDurationToMs", () => {
  it("reads a bare number as milliseconds", () => {
    expect(parseDurationToMs("30")).toBe(30);
    expect(parseDurationToMs("0")).toBe(0);
  });

  it("reads each unit, case-insensitively", () => {
    expect(parseDurationToMs("500ms")).toBe(500);
    expect(parseDurationToMs("3600s")).toBe(3_600_000);
    expect(parseDurationToMs("2m")).toBe(120_000);
    expect(parseDurationToMs("1H")).toBe(3_600_000);
    expect(parseDurationToMs("12h")).toBe(43_200_000);
    expect(parseDurationToMs("1d")).toBe(86_400_000);
    expect(parseDurationToMs("5MS")).toBe(5);
  });

  it("tolerates surrounding whitespace and a space before the unit", () => {
    expect(parseDurationToMs(" 5 s ")).toBe(5000);
    expect(parseDurationToMs("\t10m\n")).toBe(600_000);
  });

  it.each(["", "   ", "abc", "-5s", "1.5h", "5 weeks", "h", "5s5", "1e3"])("answers null for %j", (raw) => {
    expect(parseDurationToMs(raw)).toBeNull();
  });
});

describe("SettingsRepo: generic key/value", () => {
  it("reads back what was set, overwrites in place, and forgets a cleared key", () => {
    expect(settings.get("k")).toBeUndefined();
    settings.set("k", "one");
    settings.set("k", "two");
    expect(settings.get("k")).toBe("two");
    expect(sqlite.prepare("SELECT count(*) AS n FROM settings WHERE key = 'k'").get()).toEqual({ n: 1 });
    settings.clear("k");
    expect(settings.get("k")).toBeUndefined();
    settings.clear("k"); // clearing an absent key is not an error
  });
});

describe("SettingsRepo: numeric overrides fall back to the constructor default", () => {
  it("answers every default when nothing is stored", () => {
    expect(settings.runtimeEnv()).toEqual({
      allowPrivateUpstreams: false,
      logPayloadMaxChars: 1234,
      simulatedStreamingTokenRate: 77,
      sessionTtlMs: 45_000,
      promptCacheTtlMinutes: 9,
    });
    expect(settings.imageCacheMaxBytes()).toBe(4096);
    expect(settings.responseRetentionDays()).toBe(30);
    expect(settings.uiLanguage()).toBe("en");
    expect(settings.sessionEpochMs()).toBe(0);
    expect(settings.allowlist()).toEqual([]);
  });

  it("uses the built-in defaults when constructed without any", () => {
    const plain = new SettingsRepo(db);
    expect(plain.runtimeEnv()).toEqual({
      allowPrivateUpstreams: false,
      logPayloadMaxChars: 100_000,
      simulatedStreamingTokenRate: 2000,
      sessionTtlMs: 12 * 60 * 60 * 1000,
      promptCacheTtlMinutes: 30,
    });
    expect(plain.imageCacheMaxBytes()).toBe(64 * 1024 * 1024);
  });

  it("log_payload_max_chars: a non-negative integer, zero included", () => {
    for (const junk of ["-1", "1.5", "x", "Infinity"]) {
      settings.set("log_payload_max_chars", junk);
      expect(settings.logPayloadMaxChars(), junk).toBe(1234);
    }
    settings.set("log_payload_max_chars", "0");
    expect(settings.logPayloadMaxChars()).toBe(0);
    settings.setLogPayloadMaxChars(500);
    expect(settings.logPayloadMaxChars()).toBe(500);
  });

  it("simulated_streaming_token_rate: a positive integer, so zero is junk", () => {
    for (const junk of ["0", "-3", "2.5", "fast"]) {
      settings.set("simulated_streaming_token_rate", junk);
      expect(settings.simulatedStreamingTokenRate(), junk).toBe(77);
    }
    settings.setSimulatedStreamingTokenRate(1);
    expect(settings.simulatedStreamingTokenRate()).toBe(1);
  });

  it("prompt_cache_ttl_minutes: a positive integer, so zero is junk", () => {
    for (const junk of ["0", "-1", "0.5", "1h"]) {
      settings.set("prompt_cache_ttl_minutes", junk);
      expect(settings.promptCacheTtlMinutes(), junk).toBe(9);
    }
    settings.setPromptCacheTtlMinutes(60);
    expect(settings.promptCacheTtlMinutes()).toBe(60);
  });

  it("image_cache_max_bytes: a non-negative integer, zero meaning off", () => {
    for (const junk of ["-1", "10.5", "64MB"]) {
      settings.set("image_cache_max_bytes", junk);
      expect(settings.imageCacheMaxBytes(), junk).toBe(4096);
    }
    settings.setImageCacheMaxBytes(0);
    expect(settings.imageCacheMaxBytes()).toBe(0);
  });

  it("response_retention_days: an integer from 0 to 3650, else 30", () => {
    const stored = (raw: string): number => {
      settings.set("response_retention_days", raw);
      return settings.responseRetentionDays();
    };
    expect(stored("0")).toBe(0);
    expect(stored("1")).toBe(1);
    expect(stored("3650")).toBe(3650);
    expect(stored("3651")).toBe(30);
    expect(stored("-1")).toBe(30);
    expect(stored("7.5")).toBe(30);
    expect(stored("forever")).toBe(30);
  });

  it("ui_language: stored verbatim", () => {
    settings.setUiLanguage("zh");
    expect(settings.uiLanguage()).toBe("zh");
  });
});

describe("SettingsRepo: session lifetime and epoch", () => {
  it("session_ttl: an unparseable duration falls back to the default", () => {
    for (const junk of ["soon", "-5s", "1.5h"]) {
      settings.set("session_ttl", junk);
      expect(settings.sessionTtlMs(), junk).toBe(45_000);
    }
    settings.set("session_ttl", "2h");
    expect(settings.sessionTtlMs()).toBe(7_200_000);
    settings.set("session_ttl", "90"); // bare number = milliseconds
    expect(settings.sessionTtlMs()).toBe(90);
  });

  it("setSessionTtlMs stores whole seconds, rounding to the nearest", () => {
    settings.setSessionTtlMs(90_500);
    expect(settings.get("session_ttl")).toBe("91s");
    expect(settings.sessionTtlMs()).toBe(91_000);
    settings.setSessionTtlMs(90_499);
    expect(settings.sessionTtlMs()).toBe(90_000);
    expect(settings.runtimeEnv().sessionTtlMs).toBe(90_000);
  });

  it("session_epoch: anything but a positive number means no cutoff", () => {
    for (const junk of ["abc", "-1", "0", "Infinity"]) {
      settings.set("session_epoch", junk);
      expect(settings.sessionEpochMs(), junk).toBe(0);
    }
  });

  it("bumpSessionEpoch stores the cutoff in whole milliseconds", () => {
    settings.bumpSessionEpoch(1_700_000_000_123.9);
    expect(settings.sessionEpochMs()).toBe(1_700_000_000_123);
    expect(settings.get("session_epoch")).toBe("1700000000123");
  });
});

describe("SettingsRepo: the SSRF guard's cached flags", () => {
  /** What a repo booted over this stored value reports. */
  const bootedWith = (raw: string, allowPrivate = false): boolean => {
    settings.set("allow_private_upstreams", raw);
    return new SettingsRepo(db, { ...DEFAULTS, allowPrivate }).allowPrivate();
  };

  it.each(["1", "true", "yes", "on", "YES", "On", "TRUE", " 1 ", "\ttrue\n"])("allow_private_upstreams %j is on", (raw) => {
    expect(bootedWith(raw)).toBe(true);
  });

  it.each(["0", "off", "", "false", "no", "2", "enabled", "truthy"])(
    "allow_private_upstreams %j is off, even when the default is on",
    (raw) => {
      expect(bootedWith(raw, true)).toBe(false);
    },
  );

  it("uses the constructor default when nothing is stored", () => {
    expect(new SettingsRepo(db, { ...DEFAULTS, allowPrivate: true }).allowPrivate()).toBe(true);
    expect(new SettingsRepo(db, { ...DEFAULTS, allowPrivate: false }).allowPrivate()).toBe(false);
  });

  it("writeAllowPrivate takes effect at once and survives a restart", () => {
    settings.writeAllowPrivate(true);
    expect(settings.allowPrivate()).toBe(true);
    expect(settings.get("allow_private_upstreams")).toBe("true");
    expect(new SettingsRepo(db, DEFAULTS).allowPrivate()).toBe(true);
    settings.writeAllowPrivate(false);
    expect(settings.get("allow_private_upstreams")).toBe("false");
    expect(new SettingsRepo(db, { ...DEFAULTS, allowPrivate: true }).allowPrivate()).toBe(false);
  });

  it("serves the flags from memory until reload() is called", () => {
    settings.writeAllowlist(["10.0.0.0/8"]);
    // Written behind the cache's back, the way a restore replaces the table.
    sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'upstream_allowlist'").run(JSON.stringify(["192.168.0.0/16", "example.com"]));
    sqlite.prepare("INSERT INTO settings (key, value) VALUES ('allow_private_upstreams', 'true')").run();
    expect(settings.allowlist()).toEqual(["10.0.0.0/8"]);
    expect(settings.allowPrivate()).toBe(false);

    settings.reload();
    expect(settings.allowlist()).toEqual(["192.168.0.0/16", "example.com"]);
    expect(settings.allowPrivate()).toBe(true);
  });

  it("reads a stored allowlist that is not a list of strings as best it can", () => {
    const stored = (raw: string): string[] => {
      settings.set("upstream_allowlist", raw);
      return new SettingsRepo(db, DEFAULTS).allowlist();
    };
    expect(stored("{not json")).toEqual([]);
    expect(stored('{"a":1}')).toEqual([]);
    expect(stored("")).toEqual([]);
    expect(stored('["10.0.0.0/8", 5, null, "example.com"]')).toEqual(["10.0.0.0/8", "example.com"]);
  });
});
