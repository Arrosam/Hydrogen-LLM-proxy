import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/middleware";
import type { Container } from "../composition/container";
import { benchRoutes } from "./benchRoutes";
import { hostedToolRoutes } from "./hostedToolRoutes";
import { proxyRoutes } from "./proxyRoutes";

import { activeRequestRoutes } from "./admin/activeRequestRoutes";
import { authRoutes } from "./admin/authRoutes";
import { backupRoutes } from "./admin/backupRoutes";
import { catalogRoutes } from "./admin/catalogRoutes";
import { checkRoutes } from "./admin/checkRoutes";
import { logRoutes } from "./admin/logRoutes";
import { providerRoutes } from "./admin/providerRoutes";
import { serviceRoutes } from "./admin/serviceRoutes";
import { settingsRoutes } from "./admin/settingsRoutes";
import { tokenRoutes } from "./admin/tokenRoutes";
import { updateRoutes } from "./admin/updateRoutes";
import { userRoutes } from "./admin/userRoutes";

/** Registered by the app under the /admin/api prefix. */
export async function adminRoutes(app: FastifyInstance, c: Container): Promise<void> {
  // One guard instance, shared by every authenticated route. Built once here so
  // the session-epoch floor cannot be wired into some routes and forgotten in
  // others (a forgotten one would silently skip post-restore invalidation).
  const sessionGuard = requireSession(c.users, () => c.settings.sessionEpochMs());

  await app.register((scoped) => authRoutes(scoped, c, sessionGuard));
  await app.register((scoped) => checkRoutes(scoped, c));

  await app.register(async (scoped) => {
    scoped.addHook("preHandler", sessionGuard);
    await scoped.register((s) => userRoutes(s, c), { prefix: "/users" });
    await scoped.register((s) => providerRoutes(s, c), { prefix: "/providers" });
    await scoped.register((s) => proxyRoutes(s, c), { prefix: "/proxies" });
    await scoped.register((s) => catalogRoutes(s, c));
    await scoped.register((s) => serviceRoutes(s, c), { prefix: "/services" });
    await scoped.register((s) => hostedToolRoutes(s, c), { prefix: "/tools" });
    await scoped.register((s) => tokenRoutes(s, c), { prefix: "/tokens" });
    await scoped.register((s) => logRoutes(s, c));
    await scoped.register((s) => activeRequestRoutes(s, c));
    await scoped.register((s) => settingsRoutes(s, c), { prefix: "/settings" });
    await scoped.register((s) => backupRoutes(s, c), { prefix: "/backup" });
    await scoped.register((s) => updateRoutes(s, c), { prefix: "/update" });
    await scoped.register((s) => benchRoutes(s, c), { prefix: "/bench" });
  });
}
