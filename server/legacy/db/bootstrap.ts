import type { DB } from ".";
import { users } from "./schema";
import { hashPassword } from "../security/passwords";

/** Static default password used for the first admin when none is configured. */
export const DEFAULT_ADMIN_PASSWORD = "password";

export interface SeedResult {
  created: boolean;
  username?: string;
  password?: string;
  generated?: boolean;
  mustChange?: boolean;
}

/**
 * Create the initial admin account if the users table is empty. If no
 * ADMIN_PASSWORD was provided, the static default "password" is used and the
 * account is flagged to force a password change at first login.
 */
export async function seedAdminIfEmpty(
  db: DB,
  admin: { username: string; password: string },
): Promise<SeedResult> {
  const existing = db.select({ id: users.id }).from(users).limit(1).all();
  if (existing.length > 0) return { created: false };

  const provided = admin.password.trim().length > 0;
  const password = provided ? admin.password : DEFAULT_ADMIN_PASSWORD;
  const mustChange = !provided;
  const passwordHash = await hashPassword(password);

  db.insert(users)
    .values({
      username: admin.username,
      passwordHash,
      role: "admin",
      enabled: true,
      mustChangePassword: mustChange,
    })
    .run();

  return { created: true, username: admin.username, password, generated: !provided, mustChange };
}
