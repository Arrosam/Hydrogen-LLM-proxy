import { eq } from "drizzle-orm";
import type { DB } from ".";
import { users, settings } from "./schema";
import { hashPassword, verifyPassword } from "../security/passwords";

import { randomBytes } from "node:crypto";

export interface SeedResult {
  created: boolean;
  username?: string;
  password?: string;
  generated?: boolean;
  mustChange?: boolean;
}

/**
 * Create the initial admin account if the users table is empty. If no
 * ADMIN_PASSWORD was provided, a random temporary password is generated and the
 * account is flagged to force a password change at first login.
 */
export async function seedAdminIfEmpty(db: DB, admin: { username: string; password: string }): Promise<SeedResult> {
  const existing = db.select().from(users).all();
  if (existing.length > 0) {
    // Upgrade installations still using the previously published bootstrap secret.
    // User-chosen credentials and already-completed setup are never changed.
    for (const user of existing) {
      if (!user.mustChangePassword || user.role !== "admin" || !(await verifyPassword(user.passwordHash, "password"))) continue;
      const password = randomBytes(24).toString("base64url");
      const passwordHash = await hashPassword(password);
      db.transaction(() => {
        db.update(users).set({ passwordHash }).where(eq(users.id, user.id)).run();
        db.insert(settings).values({ key: "session_epoch", value: String(Date.now()) })
          .onConflictDoUpdate({ target: settings.key, set: { value: String(Date.now()) } }).run();
      });
      return { created: true, username: user.username, password, generated: true, mustChange: true };
    }
    return { created: false };
  }

  const provided = admin.password.trim().length > 0;
  const password = provided ? admin.password : randomBytes(24).toString("base64url");
  const mustChange = !provided;
  const passwordHash = await hashPassword(password);

  db.insert(users)
    .values({ username: admin.username, passwordHash, role: "admin", enabled: true, mustChangePassword: mustChange })
    .run();

  return { created: true, username: admin.username, password, generated: !provided, mustChange };
}
