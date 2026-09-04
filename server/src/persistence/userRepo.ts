import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { users, type User } from "../db/schema";
import { asMillis } from "../util/time";
import { hashPassword, verifyPassword } from "../security/passwords";

export type Role = "admin" | "manager";

export interface PublicUser {
  id: number;
  username: string;
  role: Role;
  enabled: boolean;
  mustChangePassword: boolean;
  createdAt: number;
}

export type ChangePasswordResult = "ok" | "not_found" | "wrong_current";

/**
 * A constant dummy password used to equalize login timing. When the username
 * does not exist, argon2 would otherwise be skipped and the missing account
 * answered measurably faster than the present-but-wrong one -- a free
 * username-enumeration oracle for anyone who can reach /login. Verifying
 * against a lazily-created dummy hash makes both paths pay the same cost.
 */
const DUMMY_PASSWORD = "hydrogen-timing-equalizer";
let dummyHash: string | null = null;

/** Dashboard accounts + password verification (argon2id). */
export class UserRepo {
  constructor(private readonly db: DB) {}

  toPublic(u: User): PublicUser {
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      enabled: u.enabled,
      mustChangePassword: u.mustChangePassword,
      createdAt: asMillis(u.createdAt),
    };
  }

  list(): User[] {
    return this.db.select().from(users).all();
  }

  get(id: number): User | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  getByUsername(username: string): User | undefined {
    return this.db.select().from(users).where(eq(users.username, username)).get();
  }

  count(): number {
    return this.db.select().from(users).all().length;
  }

  /** If an account still has the forced default password, hint its username on the login page. */
  initialCredentialHint(): { username: string } | null {
    const u = this.db.select().from(users).where(eq(users.mustChangePassword, true)).limit(1).get();
    return u ? { username: u.username } : null;
  }

  async create(input: {
    username: string;
    password: string;
    role: Role;
    enabled?: boolean;
    mustChangePassword?: boolean;
  }): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    return this.db
      .insert(users)
      .values({
        username: input.username,
        passwordHash,
        role: input.role,
        enabled: input.enabled ?? true,
        mustChangePassword: input.mustChangePassword ?? false,
      })
      .returning()
      .get();
  }

  /** Change a user's own password. Forced first-login change skips the current-password check. */
  async changeOwnPassword(userId: number, newPassword: string, currentPassword?: string): Promise<ChangePasswordResult> {
    const user = this.get(userId);
    if (!user) return "not_found";
    if (!user.mustChangePassword) {
      if (!currentPassword || !(await verifyPassword(user.passwordHash, currentPassword))) {
        return "wrong_current";
      }
    }
    const passwordHash = await hashPassword(newPassword);
    this.db.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, userId)).run();
    return "ok";
  }

  async update(id: number, input: { role?: Role; enabled?: boolean; password?: string }): Promise<User | undefined> {
    const patch: Record<string, unknown> = {};
    if (input.role !== undefined) patch.role = input.role;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.password) patch.passwordHash = await hashPassword(input.password);
    if (Object.keys(patch).length === 0) return this.get(id);
    return this.db.update(users).set(patch).where(eq(users.id, id)).returning().get();
  }

  delete(id: number): void {
    this.db.delete(users).where(eq(users.id, id)).run();
  }

  /** Verify a username/password login. Returns the user on success, null on
   * any failure. An unknown or disabled account still runs one argon2
   * verification against the dummy hash so response timing cannot be used to
   * distinguish "no such user" from "wrong password". */
  async verifyLogin(username: string, password: string): Promise<User | null> {
    const user = this.getByUsername(username);
    const hash = user?.passwordHash ?? (dummyHash ??= await hashPassword(DUMMY_PASSWORD));
    const ok = await verifyPassword(hash, password);
    return ok && user && user.enabled ? user : null;
  }
}
