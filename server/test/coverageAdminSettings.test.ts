/**
 * Characterization of the settings admin routes: every read and write, the
 * boundary of each numeric setting, the allowlist entry grammar, and the
 * immediate side effects of a save (pruning, eviction).
 *
 * Deliberately NOT pinned: an allowlist entry with an empty prefix length
 * ("10.0.0.0/") or extra segments ("10.0.0.0/8/9"). Whether those should be
 * accepted is an open question for the owner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requestLogs } from "../src/db/schema";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;

beforeAll(async () => {
  h = await startAdminHarness("cov-settings");
});

afterAll(async () => {
  await h.close();
});

const put = (url: string, payload: unknown) => h.admin({ method: "PUT", url: `/settings${url}`, payload });
const get = (url: string) => h.admin({ url: `/settings${url}` });

function insertLog(atMs: number): void {
  h.c.db
    .insert(requestLogs)
    .values({
      traceId: `t-${atMs}`,
      ingressFormat: "openai_completion",
      httpStatus: 200,
      latencyMs: 1,
      createdAt: new Date(atMs),
    } as never)
    .run();
}

describe("upstream allowlist", () => {
  it("starts empty", async () => {
    const res = await get("/upstream-allowlist");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [] });
  });

  it("PUT trims, drops blanks, de-duplicates and stores; GET returns the stored list", async () => {
    const res = await put("/upstream-allowlist", { entries: ["10.0.0.0/8", " 10.0.0.0/8 ", "api.example.com", ".example.com", "::1", "", "   "] });
    expect(res.statusCode).toBe(200);
    const entries = ["10.0.0.0/8", "api.example.com", ".example.com", "::1"];
    expect(res.json()).toEqual({ entries });
    expect((await get("/upstream-allowlist")).json()).toEqual({ entries });
    expect(h.c.settings.allowlist()).toEqual(entries);
  });

  it("accepts an IPv4 or IPv6 address, a v4 CIDR from /0 to /32, a hostname, and a leading-dot suffix", async () => {
    const entries = ["192.168.1.1", "2001:db8::1", "0.0.0.0/0", "10.1.2.3/32", "localhost", "a-b.example.co", ".internal", "x"];
    const res = await put("/upstream-allowlist", { entries });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries });
  });

  it("rejects anything else with 400, naming every bad entry, and stores nothing", async () => {
    const before = h.c.settings.allowlist();
    for (const bad of ["10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/1.5", "10.0.0.0/x", "::1/128", "example.com/8", "bad host", "-x.com", "x-.com", "a..b", "http://x.com"]) {
      const res = await put("/upstream-allowlist", { entries: ["good.example.com", bad] });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toEqual({ error: `invalid entries (use IP, v4 CIDR, or hostname): ${bad}` });
    }
    const two = await put("/upstream-allowlist", { entries: ["10.0.0.0/33", "ok.example.com", "bad host"] });
    expect(two.json()).toEqual({ error: "invalid entries (use IP, v4 CIDR, or hostname): 10.0.0.0/33, bad host" });
    expect(h.c.settings.allowlist()).toEqual(before);
  });

  it("holds at most 200 entries (counted before de-duplication)", async () => {
    const many = (n: number) => Array.from({ length: n }, (_v, i) => `h${i}.example.com`);
    const over = await put("/upstream-allowlist", { entries: many(201) });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toEqual({ error: "entries: Array must contain at most 200 element(s)" });
    expect((await put("/upstream-allowlist", { entries: Array(201).fill("same.example.com") })).statusCode).toBe(400);
    expect((await put("/upstream-allowlist", { entries: many(200) })).statusCode).toBe(200);

    const shape = await put("/upstream-allowlist", { entries: "10.0.0.0/8" });
    expect(shape.statusCode).toBe(400);
    expect(shape.json()).toEqual({ error: "entries: Expected array, received string" });
    expect((await put("/upstream-allowlist", { entries: [] })).json()).toEqual({ entries: [] });
  });
});

describe("log retention", () => {
  beforeEach(() => {
    h.c.logs.deleteAll();
  });

  it("GET reports 0 until set", async () => {
    const res = await get("/log-retention");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ days: 0 });
  });

  it("days must be an integer from 0 to 3650", async () => {
    const cases: Array<[unknown, string]> = [
      [{ days: -1 }, "days: Number must be greater than or equal to 0"],
      [{ days: 3651 }, "days: Number must be less than or equal to 3650"],
      [{ days: 1.5 }, "days: Expected integer, received float"],
      [{ days: "7" }, "days: Expected number, received string"],
      [{}, "days: Required"],
    ];
    for (const [payload, error] of cases) {
      const res = await put("/log-retention", payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
    expect((await put("/log-retention", { days: 3650 })).json()).toEqual({ days: 3650, pruned: 0 });
  });

  it("0 keeps everything; a positive value prunes the backlog at once and reports how much", async () => {
    insertLog(Date.now() - 2 * 86_400_000);
    insertLog(Date.now() - 3_600_000);

    const off = await put("/log-retention", { days: 0 });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ days: 0, pruned: 0 });
    expect(h.c.logs.query({}).total).toBe(2);

    const on = await put("/log-retention", { days: 1 });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ days: 1, pruned: 1 });
    expect(h.c.logs.query({}).total).toBe(1);
    expect((await get("/log-retention")).json()).toEqual({ days: 1 });
  });
});

describe("response retention", () => {
  it("GET returns the current value; PUT accepts 0..3650 and echoes it", async () => {
    expect((await get("/response-retention")).json()).toEqual({ days: h.c.settings.responseRetentionDays() });

    for (const days of [3650, 0, 7]) {
      const res = await put("/response-retention", { days });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ days });
      expect((await get("/response-retention")).json()).toEqual({ days });
    }
  });

  it("rejects out-of-range and fractional values", async () => {
    const over = await put("/response-retention", { days: 3651 });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toEqual({ error: "days: Number must be less than or equal to 3650" });
    const frac = await put("/response-retention", { days: 1.5 });
    expect(frac.statusCode).toBe(400);
    expect(frac.json()).toEqual({ error: "days: Expected integer, received float" });
    expect((await put("/response-retention", { days: -1 })).statusCode).toBe(400);
    expect((await get("/response-retention")).json()).toEqual({ days: 7 });
  });
});

describe("image cache", () => {
  const GIB = 1024 * 1024 * 1024;
  /** Ten 100-byte entries (4-byte hash + 96-byte description), oldest first. */
  const fill = (): void => {
    h.c.imageCache.clear();
    for (let i = 1; i <= 10; i++) h.c.imageCache.put([{ hash: `h${String(i).padStart(3, "0")}`, description: "x".repeat(96) }], 1_700_000_000_000 + i, 1000);
  };

  it("GET reports the budget next to what it is using", async () => {
    fill();
    const res = await get("/image-cache");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ maxBytes: h.c.settings.imageCacheMaxBytes(), entries: 10, usedBytes: 1000 });
  });

  it("lowering the budget evicts the oldest entries immediately", async () => {
    fill();
    const res = await put("/image-cache", { maxBytes: 450 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ maxBytes: 450, evicted: 6, entries: 4, usedBytes: 400 });
    expect(h.c.settings.imageCacheMaxBytes()).toBe(450);
    expect((await get("/image-cache")).json()).toEqual({ maxBytes: 450, entries: 4, usedBytes: 400 });
  });

  it("a budget that already fits evicts nothing; 0 empties the cache", async () => {
    fill();
    expect((await put("/image-cache", { maxBytes: 1000 })).json()).toEqual({ maxBytes: 1000, evicted: 0, entries: 10, usedBytes: 1000 });
    expect((await put("/image-cache", { maxBytes: 0 })).json()).toEqual({ maxBytes: 0, evicted: 10, entries: 0, usedBytes: 0 });
  });

  it("the budget is an integer from 0 to 64 GiB", async () => {
    const cases: Array<[unknown, string]> = [
      [{ maxBytes: -1 }, "maxBytes: Number must be greater than or equal to 0"],
      [{ maxBytes: 64 * GIB + 1 }, `maxBytes: Number must be less than or equal to ${64 * GIB}`],
      [{ maxBytes: 1.5 }, "maxBytes: Expected integer, received float"],
      [{}, "maxBytes: Required"],
    ];
    for (const [payload, error] of cases) {
      const res = await put("/image-cache", payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
    expect((await put("/image-cache", { maxBytes: 64 * GIB })).json()).toMatchObject({ maxBytes: 64 * GIB, evicted: 0 });
  });

  it("DELETE clears every entry and reports how many, keeping the budget", async () => {
    await put("/image-cache", { maxBytes: 5000 });
    fill();
    const res = await h.admin({ method: "DELETE", url: "/settings/image-cache" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cleared: 10, maxBytes: 5000, entries: 0, usedBytes: 0 });
    expect((await h.admin({ method: "DELETE", url: "/settings/image-cache" })).json()).toEqual({ cleared: 0, maxBytes: 5000, entries: 0, usedBytes: 0 });
  });
});

describe("UI language", () => {
  it("is readable by every dashboard user and writable by an admin, in en or zh only", async () => {
    expect((await h.manager({ url: "/settings/ui-language" })).statusCode).toBe(200);

    const zh = await put("/ui-language", { language: "zh" });
    expect(zh.statusCode).toBe(200);
    expect(zh.json()).toEqual({ language: "zh" });
    expect((await h.manager({ url: "/settings/ui-language" })).json()).toEqual({ language: "zh" });

    const fr = await put("/ui-language", { language: "fr" });
    expect(fr.statusCode).toBe(400);
    expect(fr.json()).toEqual({ error: "language: Invalid enum value. Expected 'en' | 'zh', received 'fr'" });
    expect((await get("/ui-language")).json()).toEqual({ language: "zh" });

    expect((await put("/ui-language", { language: "en" })).json()).toEqual({ language: "en" });
  });
});

describe("version", () => {
  it("reports the running server's version string", async () => {
    const res = await get("/version");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  });
});

describe("runtime environment settings", () => {
  const RUNTIME_KEYS = ["allowPrivateUpstreams", "logPayloadMaxChars", "promptCacheTtlMinutes", "sessionTtlMs", "simulatedStreamingTokenRate"];

  it("GET returns the runtime values plus the read-only boot values", async () => {
    const res = await get("/env");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual([...RUNTIME_KEYS, "env"].sort());
    expect(Object.keys(body.env).sort()).toEqual(["adminUsername", "cookieSecure", "dataDir", "host", "nodeEnv", "port", "trustProxy"]);
    expect(body.env).toMatchObject({ nodeEnv: "test", adminUsername: "admin", dataDir: h.c.config.dataDir });
  });

  it("PUT changes only the keys it names, and answers what a following GET (minus env) returns", async () => {
    const before = (await get("/env")).json();
    const res = await put("/env", { logPayloadMaxChars: 1234 });
    expect(res.statusCode).toBe(200);
    const { env: _env, ...runtime } = before;
    expect(res.json()).toEqual({ ...runtime, logPayloadMaxChars: 1234 });

    const { env: _after, ...now } = (await get("/env")).json();
    expect(now).toEqual(res.json());

    const empty = await put("/env", {});
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual(res.json());
  });

  it("PUT sets every key at once", async () => {
    const all = { allowPrivateUpstreams: true, logPayloadMaxChars: 500, simulatedStreamingTokenRate: 10, sessionTtlMs: 120_000, promptCacheTtlMinutes: 5 };
    const res = await put("/env", all);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(all);
    expect((await put("/env", { allowPrivateUpstreams: false })).json()).toEqual({ ...all, allowPrivateUpstreams: false });
  });

  it("each key has its own range", async () => {
    const DAY = 86_400_000;
    const rejected: Array<[Record<string, unknown>, string]> = [
      [{ sessionTtlMs: 59_999 }, "sessionTtlMs: Number must be greater than or equal to 60000"],
      [{ sessionTtlMs: 30 * DAY + 1 }, `sessionTtlMs: Number must be less than or equal to ${30 * DAY}`],
      [{ simulatedStreamingTokenRate: 0 }, "simulatedStreamingTokenRate: Number must be greater than or equal to 1"],
      [{ simulatedStreamingTokenRate: 1_000_001 }, "simulatedStreamingTokenRate: Number must be less than or equal to 1000000"],
      [{ logPayloadMaxChars: -1 }, "logPayloadMaxChars: Number must be greater than or equal to 0"],
      [{ logPayloadMaxChars: 10_000_001 }, "logPayloadMaxChars: Number must be less than or equal to 10000000"],
      [{ promptCacheTtlMinutes: 0 }, "promptCacheTtlMinutes: Number must be greater than or equal to 1"],
      [{ promptCacheTtlMinutes: 1441 }, "promptCacheTtlMinutes: Number must be less than or equal to 1440"],
      [{ allowPrivateUpstreams: "yes" }, "allowPrivateUpstreams: Expected boolean, received string"],
    ];
    const snapshot = h.c.settings.runtimeEnv();
    for (const [payload, error] of rejected) {
      const res = await put("/env", payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
    expect(h.c.settings.runtimeEnv()).toEqual(snapshot);

    const accepted: Array<Record<string, number>> = [
      { sessionTtlMs: 60_000 },
      { sessionTtlMs: 30 * DAY },
      { simulatedStreamingTokenRate: 1 },
      { simulatedStreamingTokenRate: 1_000_000 },
      { logPayloadMaxChars: 0 },
      { logPayloadMaxChars: 10_000_000 },
      { promptCacheTtlMinutes: 1 },
      { promptCacheTtlMinutes: 1440 },
    ];
    for (const payload of accepted) {
      const res = await put("/env", payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(200);
      expect(res.json()).toMatchObject(payload);
    }
  });

  it("a rejected body applies none of its keys, even the valid ones", async () => {
    await put("/env", { logPayloadMaxChars: 777 });
    const res = await put("/env", { logPayloadMaxChars: 888, promptCacheTtlMinutes: 0 });
    expect(res.statusCode).toBe(400);
    expect(h.c.settings.runtimeEnv().logPayloadMaxChars).toBe(777);
  });
});

describe("a manager", () => {
  it("is refused every settings route except reading the UI language", async () => {
    const cases: Array<[Parameters<AdminHarness["manager"]>[0], string]> = [
      [{ url: "/settings/response-retention" }, "view settings"],
      [{ method: "PUT", url: "/settings/response-retention", payload: { days: 1 } }, "change response retention"],
      [{ url: "/settings/log-retention" }, "view settings"],
      [{ method: "PUT", url: "/settings/log-retention", payload: { days: 1 } }, "change log retention"],
      [{ url: "/settings/image-cache" }, "view settings"],
      [{ method: "PUT", url: "/settings/image-cache", payload: { maxBytes: 0 } }, "change the image cache budget"],
      [{ method: "DELETE", url: "/settings/image-cache" }, "clear the image cache"],
      [{ url: "/settings/upstream-allowlist" }, "view settings"],
      [{ method: "PUT", url: "/settings/upstream-allowlist", payload: { entries: [] } }, "edit the upstream allowlist"],
      [{ method: "PUT", url: "/settings/ui-language", payload: { language: "zh" } }, "change the UI language"],
      [{ url: "/settings/version" }, "view settings"],
      [{ url: "/settings/env" }, "view settings"],
      [{ method: "PUT", url: "/settings/env", payload: { logPayloadMaxChars: 1 } }, "change environment settings"],
    ];
    const snapshot = { env: h.c.settings.runtimeEnv(), language: h.c.settings.uiLanguage(), allowlist: h.c.settings.allowlist() };
    for (const [call, action] of cases) {
      const res = await h.manager(call);
      expect(res.statusCode, `${call.method ?? "GET"} ${call.url}`).toBe(403);
      expect(res.json()).toEqual({ error: `only an admin can ${action}` });
    }
    expect({ env: h.c.settings.runtimeEnv(), language: h.c.settings.uiLanguage(), allowlist: h.c.settings.allowlist() }).toEqual(snapshot);
  });
});
