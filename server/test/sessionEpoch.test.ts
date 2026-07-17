/**
 * A restore replaces the users table, so every existing session must die -- not
 * just the caller's cookie. requireSession enforces an instance-wide cutoff:
 * a session issued before the floor is rejected however valid it otherwise is.
 */
import { describe, expect, it, beforeAll } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { setConfig } from "../src/context";
import type { AppConfig } from "../src/config";
import { requireSession } from "../src/auth/middleware";
import { signSession, SESSION_COOKIE } from "../src/auth/session";
import type { UserRepo } from "../src/persistence/userRepo";

beforeAll(() => {
  setConfig({
    sessionSecret: "test-secret-please-ignore-0123456789",
    sessionTtlMs: 12 * 60 * 60 * 1000,
    cookieSecure: "false",
  } as AppConfig);
});

const users = {
  get: (id: number) => (id === 1 ? { id: 1, username: "admin", role: "admin", enabled: true } : undefined),
} as unknown as UserRepo;

/** A reply stub that records the first code()/send() it receives. */
function fakeReply(): { reply: FastifyReply; status: () => number | null } {
  let code: number | null = null;
  const reply = {
    code(c: number) {
      code = c;
      return this;
    },
    async send() {
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, status: () => code };
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
