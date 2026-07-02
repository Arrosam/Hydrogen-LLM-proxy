import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { users, type User } from "../db/schema";
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

export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    enabled: u.enabled,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt instanceof Date ? u.createdAt.getTime() : Number(u.createdAt),
  };
}

export function listUsers(): User[] {
  return getDb().select().from(users).all();
}

export function getUser(id: number): User | undefined {
  return getDb().select().from(users).where(eq(users.id, id)).get();
}

export function getUserByUsername(username: string): User | undefined {
  return getDb().select().from(users).where(eq(users.username, username)).get();
}

export function countUsers(): number {
  return getDb().select().from(users).all().length;
}

/**
 * If an account still has the forced default password (mustChangePassword),
 * return its username so the login page can hint the initial credentials.
 */
export function getInitialCredentialHint(): { username: string } | null {
  const u = getDb().select().from(users).where(eq(users.mustChangePassword, true)).limit(1).get();
  return u ? { username: u.username } : null;
}

export async function createUser(input: {
  username: string;
  password: string;
  role: Role;
  enabled?: boolean;
  mustChangePassword?: boolean;
}): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  return getDb()
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

export type ChangePasswordResult = "ok" | "not_found" | "wrong_current";

/**
 * Change a user's own password. When the account is flagged mustChangePassword
 * (forced first-login change), the current password is not required; otherwise
 * it must be supplied and verified.
 */
export async function changeOwnPassword(
  userId: number,
  newPassword: string,
  currentPassword?: string,
): Promise<ChangePasswordResult> {
  const user = getUser(userId);
  if (!user) return "not_found";
  if (!user.mustChangePassword) {
    if (!currentPassword || !(await verifyPassword(user.passwordHash, currentPassword))) {
      return "wrong_current";
    }
  }
  const passwordHash = await hashPassword(newPassword);
  getDb()
    .update(users)
    .set({ passwordHash, mustChangePassword: false })
    .where(eq(users.id, userId))
    .run();
  return "ok";
}

export async function updateUser(
  id: number,
  input: { role?: Role; enabled?: boolean; password?: string },
): Promise<User | undefined> {
  const patch: Record<string, unknown> = {};
  if (input.role !== undefined) patch.role = input.role;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.password) patch.passwordHash = await hashPassword(input.password);
  if (Object.keys(patch).length === 0) return getUser(id);
  return getDb().update(users).set(patch).where(eq(users.id, id)).returning().get();
}

export function deleteUser(id: number): void {
  getDb().delete(users).where(eq(users.id, id)).run();
}

/** Verify a username/password login. Returns the user on success. */
export async function verifyLogin(username: string, password: string): Promise<User | null> {
  const user = getUserByUsername(username);
  if (!user || !user.enabled) return null;
  const ok = await verifyPassword(user.passwordHash, password);
  return ok ? user : null;
}
