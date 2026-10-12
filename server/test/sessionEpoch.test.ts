/**
 * A restore replaces the users table, so every existing session must die -- not
 * just the caller's cookie. requireSession enforces an instance-wide cutoff:
 * a session issued before the floor is rejected however valid it otherwise is.
 */
import { afterEach, describe, expect, it, beforeAll, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { setConfig } from "../src/context";
import type { AppConfig } from "../src/config";
import { requireSession } from "../src/auth/middleware";
import { resolveCookieSecure, signSession, verifySession, SESSION_COOKIE } from "../src/auth/session";
import type { UserRepo } from "../src/persistence/userRepo";

const SECRET = "test-secret-please-ignore-0123456789";
const TTL_MS = 12 * 60 * 60 * 1000;

const configure = (cookieSecure: AppConfig["cookieSecure"] = "false"): void =>
  setConfig({ sessionSecret: SECRET, sessionTtlMs: TTL_MS, cookieSecure } as AppConfig);

beforeAll(() => {
  configure();
});

const users = {
  get: (id: number) => (id === 1 ? { id: 1, username: "admin", role: "admin", enabled: true } : undefined),
} as unknown as UserRepo;

/** A reply stub that records the first code()/send() it receives. */
function fakeReply(): { reply: FastifyReply; status: () => number | null; body: () => unknown } {
  let code: number | null = null;
  let sent: unknown;
  const reply = {
    code(c: number) {
      code = c;
      return this;
    },
    async send(payload?: unknown) {
      sent = payload;
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, status: () => code, body: () => sent };
}

const reqWith = (token: string): FastifyRequest => ({ cookies: { [SESSION_COOKIE]: token } }) as unknown as FastifyRequest;

describe("session epoch floor", () => {
  it("accepts a valid session when the floor is zero", async () => {
    const token = signSession({ uid: 1, username: "admin", role: "admin" });
    const req = reqWith(token);
    const { reply, status } = fakeReply();
    await requireSession(users, () => 0)(req, reply);
    expect(status()).toBeNull(); // never rejected
    expect(req.user?.uid).toBe(1);
  });

  it("rejects a session issued before the floor", async () => {
    const token = signSession({ uid: 1, username: "admin", role: "admin" });
    // Floor set to the future: the token's iat is strictly before it.
    const floorMs = (Math.floor(Date.now() / 1000) + 5) * 1000;
    const { reply, status } = fakeReply();
    const req = reqWith(token);
    await requireSession(users, () => floorMs)(req, reply);
    expect(status()).toBe(401);
    expect(req.user).toBeUndefined();
  });

  it("kills a session issued in the same second as the floor (no pre-restore survivor)", async () => {
    // A restore and a victim login can land in the same wall-clock second; the
    // security guarantee is that the session still dies.
    const token = signSession({ uid: 1, username: "admin", role: "admin" });
    const floorMs = Math.floor(Date.now() / 1000) * 1000;
    const { reply, status } = fakeReply();
    await requireSession(users, () => floorMs)(reqWith(token), reply);
    expect(status()).toBe(401);
  });
});

describe("requireSession rejections that are not about the floor", () => {
  /** Run the guard and report what it answered and whether it bound a user. */
  async function guard(req: FastifyRequest, repo: UserRepo = users) {
    const { reply, status, body } = fakeReply();
    await requireSession(repo, () => 0)(req, reply);
    return { status: status(), body: body(), user: req.user };
  }

  it("rejects a request that carries no session cookie", async () => {
    const noCookie = await guard({ cookies: {} } as unknown as FastifyRequest);
    expect(noCookie).toEqual({ status: 401, body: { error: "unauthorized" }, user: undefined });
    // No cookie jar at all (the cookie plugin never ran) is the same answer.
    expect((await guard({} as unknown as FastifyRequest)).status).toBe(401);
  });

  it("rejects a cookie that is not a token", async () => {
    expect(await guard(reqWith("garbage"))).toEqual({ status: 401, body: { error: "unauthorized" }, user: undefined });
  });

  it("rejects a valid session whose user no longer exists", async () => {
    const token = signSession({ uid: 2, username: "ghost", role: "admin" });
    expect(await guard(reqWith(token))).toEqual({ status: 401, body: { error: "unauthorized" }, user: undefined });
  });

  it("rejects a valid session whose user has been disabled", async () => {
    const disabled = {
      get: () => ({ id: 1, username: "admin", role: "admin", enabled: false }),
    } as unknown as UserRepo;
    const token = signSession({ uid: 1, username: "admin", role: "admin" });
    expect(await guard(reqWith(token), disabled)).toEqual({ status: 401, body: { error: "unauthorized" }, user: undefined });
  });

  it("rejects a session signed with a different secret", async () => {
    const forged = jwt.sign({ uid: 1, username: "admin", role: "admin" }, "some-other-secret-0123456789abcdef", { expiresIn: 3600 });
    expect(await guard(reqWith(forged))).toEqual({ status: 401, body: { error: "unauthorized" }, user: undefined });
  });

  it("binds the live user's identity, not the token's claims", async () => {
    // The token says manager/"stale"; the repository row is what gets bound.
    const token = signSession({ uid: 1, username: "stale", role: "manager" });
    const result = await guard(reqWith(token));
    expect(result.status).toBeNull();
    expect(result.user).toEqual({ uid: 1, username: "admin", role: "admin" });
  });
});

describe("verifySession", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("decodes what signSession issued, with an issued-at stamp", () => {
    const decoded = verifySession(signSession({ uid: 7, username: "ann", role: "admin" }));
    expect(decoded).toMatchObject({ uid: 7, username: "ann", role: "admin" });
    expect(typeof decoded?.iat).toBe("number");
  });

  it("reports passwordChangeOnly as false when the claim is absent, true only when set", () => {
    expect(verifySession(signSession({ uid: 1, username: "admin", role: "admin" }))?.passwordChangeOnly).toBe(false);
    expect(
      verifySession(signSession({ uid: 1, username: "admin", role: "admin", passwordChangeOnly: true }))?.passwordChangeOnly,
    ).toBe(true);
  });

  it("refuses a correctly signed token whose uid is not a number", () => {
    const token = jwt.sign({ uid: "1", username: "admin", role: "admin" }, SECRET, { expiresIn: 3600 });
    expect(verifySession(token)).toBeNull();
  });

  it("decodes an unknown role as manager, never as admin", () => {
    const token = jwt.sign({ uid: 1, username: "admin", role: "superuser" }, SECRET, { expiresIn: 3600 });
    expect(verifySession(token)?.role).toBe("manager");
  });

  it("refuses a token once its TTL has passed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = signSession({ uid: 1, username: "admin", role: "admin" });
    vi.setSystemTime(Date.now() + TTL_MS - 1000);
    expect(verifySession(token)?.uid).toBe(1); // still inside the TTL
    vi.setSystemTime(Date.now() + 2000);
    expect(verifySession(token)).toBeNull();
  });

  it("refuses garbage and a token signed with another secret", () => {
    expect(verifySession("garbage")).toBeNull();
    expect(verifySession(jwt.sign({ uid: 1, username: "admin", role: "admin" }, "some-other-secret-0123456789abcdef"))).toBeNull();
  });
});

describe("resolveCookieSecure", () => {
  afterEach(() => {
    configure(); // back to what the rest of this file expects
  });

  it('is always on for "true" and always off for "false", whatever the request scheme', () => {
    configure("true");
    expect(resolveCookieSecure(false)).toBe(true);
    expect(resolveCookieSecure(true)).toBe(true);
    configure("false");
    expect(resolveCookieSecure(false)).toBe(false);
    expect(resolveCookieSecure(true)).toBe(false);
  });

  it('mirrors the request scheme for "auto"', () => {
    configure("auto");
    expect(resolveCookieSecure(true)).toBe(true);
    expect(resolveCookieSecure(false)).toBe(false);
  });
});
