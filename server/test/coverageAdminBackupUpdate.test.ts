/**
 * Characterization of the backup and update admin routes -- the HTTP layer
 * around the archive functions and the update service, which their own unit
 * suites never reach: body validation, the "no restore while requests are in
 * flight" refusal, what a successful restore does to sessions, statistics and
 * the image cache, and the restart gate.
 *
 * The clock is skewed forward (never backward) by `advanceClock`, because a
 * restore invalidates every session issued in the same second or earlier, and
 * the suite has to sign in again afterwards without sleeping for real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ADMIN_PASSWORD, startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;
let admin: string;
let skewMs = 0;

const realNow = Date.now.bind(Date);
const PASSPHRASE = "correct horse battery";

/** Move the clock past the current second and sign in again as the admin. */
async function freshAdmin(): Promise<string> {
  skewMs += 2_000;
  admin = await h.login("admin", ADMIN_PASSWORD);
  return admin;
}

beforeAll(async () => {
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
  h = await startAdminHarness("cov-backup");
  admin = h.adminCookie;
});

afterAll(async () => {
  await h.close();
  vi.restoreAllMocks();
});

const exportBackup = async (payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await h.as(admin, { method: "POST", url: "/backup/export", payload: { passphrase: PASSPHRASE, ...payload } });
  expect(res.statusCode).toBe(200);
  return res.json().backup;
};
const restore = (payload: unknown) => h.as(admin, { method: "POST", url: "/backup/restore", payload });

function recordLog(httpStatus = 200): void {
  h.c.requestLogger.record({
    traceId: `t-${Math.random()}`,
    tokenId: null,
    serviceId: null,
    requestedService: "svc",
    servedModel: "m",
    servedProvider: "p",
    ingress: "openai_completion",
    egress: "openai_completion",
    streaming: false,
    httpStatus,
    http: { method: "POST", path: "/v1/chat/completions", query: "", headers: {}, bodyPayload: "{}" },
    latencyMs: 10,
  } as never);
}

describe("POST /backup/export", () => {
  it("needs a passphrase of at least 8 characters", async () => {
    const short = await h.as(admin, { method: "POST", url: "/backup/export", payload: { passphrase: "1234567" } });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toEqual({ error: "passphrase: passphrase must be at least 8 characters" });

    const none = await h.as(admin, { method: "POST", url: "/backup/export", payload: {} });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toEqual({ error: "passphrase: Required" });

    const flag = await h.as(admin, { method: "POST", url: "/backup/export", payload: { passphrase: PASSPHRASE, includeLogs: "yes" } });
    expect(flag.statusCode).toBe(400);
    expect(flag.json()).toEqual({ error: "includeLogs: Expected boolean, received string" });
  });

  it("an 8-character passphrase exports {backup}: logs included, image cache left out by default", async () => {
    const res = await h.as(admin, { method: "POST", url: "/backup/export", payload: { passphrase: "12345678" } });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(["backup"]);
    const { backup } = res.json();
    expect(backup).toMatchObject({ format: "hydrogen-backup", includesLogs: true, includesImageCache: false });
    expect(Object.keys(backup.tables)).toContain("users");
    expect(Object.keys(backup.tables)).toContain("request_logs");
    expect(Object.keys(backup.tables)).not.toContain("image_cache");
    expect(res.body).not.toContain("12345678");
  });

  it("honours includeLogs:false and includeImageCache:true", async () => {
    const backup = await exportBackup({ includeLogs: false, includeImageCache: true });
    expect(backup).toMatchObject({ includesLogs: false, includesImageCache: true });
    const tables = Object.keys(backup.tables as Record<string, unknown>);
    expect(tables).not.toContain("request_logs");
    expect(tables).toContain("image_cache");
  });
});

describe("POST /backup/restore -- refusals leave everything as it was", () => {
  let backup: Record<string, unknown>;
  beforeAll(async () => {
    h.c.models.create({ name: "in-the-backup" });
    backup = await exportBackup();
    h.c.models.create({ name: "after-the-backup" });
  });

  const untouched = async (): Promise<void> => {
    expect(h.c.models.list().map((m) => m.name)).toEqual(["in-the-backup", "after-the-backup"]);
    expect((await h.as(admin, { url: "/me" })).statusCode).toBe(200);
  };

  it("a missing or empty passphrase is 400", async () => {
    const empty = await restore({ passphrase: "", backup });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: "passphrase: passphrase is required" });
    const none = await restore({ backup });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toEqual({ error: "passphrase: Required" });
    await untouched();
  });

  it("the wrong passphrase is 400 with the reason", async () => {
    const res = await restore({ passphrase: "not the passphrase", backup });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "wrong passphrase, or this backup has been modified" });
    expect(res.headers["set-cookie"]).toBeUndefined();
    await untouched();
  });

  it("something that is not a backup is 400", async () => {
    for (const bad of [{ format: "x" }, {}]) {
      const res = await restore({ passphrase: PASSPHRASE, backup: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json()).toEqual({ error: "not a Hydrogen backup file" });
    }
    // Not an object at all (or absent): a different message, same status.
    for (const payload of [{ passphrase: PASSPHRASE, backup: "text" }, { passphrase: PASSPHRASE, backup: 5 }, { passphrase: PASSPHRASE, backup: null }, { passphrase: PASSPHRASE }]) {
      const res = await restore(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error: "not a backup file" });
    }
    await untouched();
  });

  it("is refused with 409 while any request is in flight, before the body is even looked at", async () => {
    h.c.activeRequests.start({ traceId: "in-flight", tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: true });
    try {
      const res = await restore({ passphrase: PASSPHRASE, backup });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "Wait for active requests to finish or cancel them before restoring a backup" });
      expect((await restore({})).statusCode).toBe(409);
      await untouched();
    } finally {
      h.c.activeRequests.clear();
    }
  });
});

describe("POST /backup/restore -- success", () => {
  it("replaces the data, reports what it restored, and signs every session out", async () => {
    const before = h.c.models.list().map((m) => m.name);
    const backup = await exportBackup();
    h.c.models.create({ name: "added-later" });
    const stale = admin;
    const staleManager = h.managerCookie;

    const res = await restore({ passphrase: PASSPHRASE, backup });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["includedImageCache", "includedLogs", "ok", "providerKeysRestored", "restored"]);
    expect(body).toMatchObject({ ok: true, includedLogs: true, includedImageCache: false, providerKeysRestored: 0 });
    expect(body.restored).toMatchObject({ users: 2, models: before.length });
    expect(h.c.models.list().map((m) => m.name)).toEqual(before);

    // The caller's cookie is cleared...
    expect(res.cookies.find((c) => c.name === "hydrogen_session")).toMatchObject({ value: "", path: "/" });
    // ...and every pre-restore session is dead instance-wide, not just the caller's.
    for (const cookie of [stale, staleManager]) {
      const me = await h.as(cookie, { url: "/me" });
      expect(me.statusCode).toBe(401);
      expect(me.json()).toEqual({ error: "session expired, please sign in again" });
      expect((await h.as(cookie, { url: "/models" })).statusCode).toBe(401);
    }

    // The restored accounts sign in as before.
    const fresh = await freshAdmin();
    expect((await h.as(fresh, { url: "/me" })).json().user).toMatchObject({ username: "admin", role: "admin" });
  });

  it("a package with logs replaces the log and the statistics are rebuilt from it", async () => {
    h.c.logs.deleteAll();
    h.c.statsCache.reset();
    recordLog(200);
    recordLog(500);
    const backup = await exportBackup();
    recordLog(200);
    recordLog(200);
    expect((await h.as(admin, { url: "/stats/summary" })).json()).toMatchObject({ requests: 4, errors: 1 });

    expect((await restore({ passphrase: PASSPHRASE, backup })).json()).toMatchObject({ ok: true, includedLogs: true });
    await freshAdmin();
    expect(h.c.logs.query({}).total).toBe(2);
    expect((await h.as(admin, { url: "/stats/summary" })).json()).toMatchObject({ requests: 2, errors: 1 });
    expect((await h.as(admin, { url: "/stats/summary" })).json()).toEqual(h.c.stats.summary({}));
  });

  it("a config-only package leaves the log and its statistics alone", async () => {
    const backup = await exportBackup({ includeLogs: false });
    recordLog(200);
    const expected = h.c.statsCache.summary();
    expect(expected.requests).toBe(3);

    expect((await restore({ passphrase: PASSPHRASE, backup })).json()).toMatchObject({ ok: true, includedLogs: false });
    await freshAdmin();
    expect(h.c.logs.query({}).total).toBe(3);
    expect((await h.as(admin, { url: "/stats/summary" })).json()).toEqual(expected);
  });

  it("re-reads the restored settings and trims the image cache to the restored budget", async () => {
    h.c.settings.setImageCacheMaxBytes(450);
    h.c.settings.writeAllowlist(["restored.example.com"]);
    const backup = await exportBackup();

    // After the export: a bigger budget, a full cache, another allowlist.
    h.c.settings.setImageCacheMaxBytes(5000);
    h.c.settings.writeAllowlist(["later.example.com"]);
    h.c.imageCache.clear();
    for (let i = 1; i <= 10; i++) h.c.imageCache.put([{ hash: `h${String(i).padStart(3, "0")}`, description: "x".repeat(96) }], 1_700_000_000_000 + i, 5000);
    expect(h.c.imageCache.stats()).toEqual({ entries: 10, usedBytes: 1000 });

    expect((await restore({ passphrase: PASSPHRASE, backup })).statusCode).toBe(200);
    expect(h.c.settings.imageCacheMaxBytes()).toBe(450);
    expect(h.c.settings.allowlist()).toEqual(["restored.example.com"]);
    expect(h.c.imageCache.stats()).toEqual({ entries: 4, usedBytes: 400 });
    await freshAdmin();
  });
});

describe("a manager and backups", () => {
  it("can neither export nor restore", async () => {
    const manager = await h.login("mgr", "coverage-manager-pass");
    const exp = await h.as(manager, { method: "POST", url: "/backup/export", payload: { passphrase: PASSPHRASE } });
    expect(exp.statusCode).toBe(403);
    expect(exp.json()).toEqual({ error: "only an admin can export a backup" });
    const res = await h.as(manager, { method: "POST", url: "/backup/restore", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "only an admin can restore a backup" });
    expect((await h.as(manager, { url: "/bench/targets" })).statusCode).toBe(200);
  });
});

describe("update routes", () => {
  const STATUS = { current: "1.0.0", latest: "1.1.0", updateAvailable: true, releaseUrl: null, releaseNotes: null, restartSupported: false };
  let manager: string;

  function stubUpdates(restartSupported: boolean) {
    const stub = { restartSupported, check: vi.fn(async (_force?: boolean) => STATUS), scheduleRestart: vi.fn() };
    (h.c as unknown as { updates: unknown }).updates = stub;
    return stub;
  }

  beforeAll(async () => {
    manager = await h.login("mgr", "coverage-manager-pass");
  });

  it("GET /update/check returns the service's status verbatim and forces a refetch only for refresh=1", async () => {
    const stub = stubUpdates(false);
    const res = await h.as(admin, { url: "/update/check" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(STATUS);
    expect(stub.check).toHaveBeenLastCalledWith(false);

    await h.as(admin, { url: "/update/check?refresh=1" });
    expect(stub.check).toHaveBeenLastCalledWith(true);

    for (const q of ["?refresh=true", "?refresh=0", "?refresh=", "?refresh=yes"]) {
      await h.as(admin, { url: `/update/check${q}` });
      expect(stub.check, q).toHaveBeenLastCalledWith(false);
    }
    expect(stub.check).toHaveBeenCalledTimes(6);
  });

  it("POST /update/restart is 409 unless the deployment opted in, and schedules nothing", async () => {
    const stub = stubUpdates(false);
    const res = await h.as(admin, { method: "POST", url: "/update/restart" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "remote restart is disabled for this deployment; update and restart it through its supervisor" });
    expect(stub.scheduleRestart).not.toHaveBeenCalled();
  });

  it("POST /update/restart answers 200 {restarting:true} and schedules exactly one restart when supported", async () => {
    const stub = stubUpdates(true);
    const res = await h.as(admin, { method: "POST", url: "/update/restart" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restarting: true });
    expect(stub.scheduleRestart).toHaveBeenCalledTimes(1);
    expect(stub.scheduleRestart).toHaveBeenCalledWith();
  });

  it("a manager can neither check nor restart, and the service is never consulted", async () => {
    const stub = stubUpdates(true);
    const check = await h.as(manager, { url: "/update/check?refresh=1" });
    expect(check.statusCode).toBe(403);
    expect(check.json()).toEqual({ error: "only an admin can check for updates" });
    const restart = await h.as(manager, { method: "POST", url: "/update/restart" });
    expect(restart.statusCode).toBe(403);
    expect(restart.json()).toEqual({ error: "only an admin can restart the server" });
    expect(stub.check).not.toHaveBeenCalled();
    expect(stub.scheduleRestart).not.toHaveBeenCalled();
  });
});
