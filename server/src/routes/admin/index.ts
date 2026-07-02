import type { FastifyInstance } from "fastify";
import { requireSession } from "../../auth/middleware";
import { authRoutes } from "./authRoutes";
import { userRoutes } from "./userRoutes";
import { providerRoutes } from "./providerRoutes";
import { catalogRoutes } from "./catalogRoutes";
import { mubRoutes } from "./mubRoutes";
import { tokenRoutes } from "./tokenRoutes";
import { logRoutes } from "./logRoutes";

/** Registered by the app under the /admin/api prefix. */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Public: login / logout / me.
  await app.register(authRoutes);

  // Everything else requires a valid dashboard session.
  await app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession);
    await scoped.register(userRoutes, { prefix: "/users" });
    await scoped.register(providerRoutes, { prefix: "/providers" });
    await scoped.register(catalogRoutes); // /models, /mappings
    await scoped.register(mubRoutes, { prefix: "/mubs" });
    await scoped.register(tokenRoutes, { prefix: "/tokens" });
    await scoped.register(logRoutes); // /logs, /stats/*
  });
}
