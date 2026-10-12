import { ENTITY_ICON } from "./icons";

/**
 * The one route table. `App.tsx` turns it into <Route>s (and decides which
 * element each id renders); `Layout.tsx` turns it into the sidebar, in this
 * order.
 */

export type RouteId =
  | "overview"
  | "services"
  | "microAgents"
  | "tools"
  | "models"
  | "providers"
  | "proxies"
  | "tokens"
  | "bench"
  | "logs"
  | "activeRequests"
  | "users"
  | "check"
  | "settings";

export interface RouteDef {
  id: RouteId;
  /** Absolute path, as linked from the sidebar. */
  path: string;
  labelKey: string;
  icon: string;
  /** Hidden from the sidebar and not routable for anyone who is not an admin.
   * Hiding the link is presentation; leaving the route out is what makes typing
   * the URL not work. The server enforces it too. */
  adminOnly?: boolean;
  /** A public page outside the Layout: no login required, and the sidebar
   * opens it in a new tab. */
  external?: boolean;
}

export const HOME_PATH = "/";

/** Singular, and it must stay singular: the fuzzy endpoint adapter rewrites
 * any path ending "/models" onto the proxy's /v1/models, so a SPA route
 * spelled "/models" never survives a hard load (refresh, bookmark, pasted
 * URL). "/model" is not in that suffix table. See server/src/transport/fuzzyUrl.ts. */
export const MODELS_PATH = "/model";

/** The pre-rename path of the Models page; still redirected from inside the app. */
export const LEGACY_MODELS_SEGMENT = "models";

export const TOOLS_PATH = "/tools";
export const CHECK_PATH = "/check";

export const ROUTES: readonly RouteDef[] = [
  { id: "overview", path: HOME_PATH, labelKey: "nav.overview", icon: ENTITY_ICON.overview },
  { id: "services", path: "/services", labelKey: "nav.modelServices", icon: ENTITY_ICON.service },
  { id: "microAgents", path: "/micro-agents", labelKey: "nav.microAgents", icon: ENTITY_ICON.microAgent },
  { id: "tools", path: TOOLS_PATH, labelKey: "nav.tools", icon: ENTITY_ICON.tool, adminOnly: true },
  { id: "models", path: MODELS_PATH, labelKey: "nav.models", icon: ENTITY_ICON.model },
  { id: "providers", path: "/providers", labelKey: "nav.providers", icon: ENTITY_ICON.provider },
  { id: "proxies", path: "/proxies", labelKey: "nav.proxies", icon: ENTITY_ICON.proxy },
  { id: "tokens", path: "/tokens", labelKey: "nav.tokens", icon: ENTITY_ICON.token },
  { id: "bench", path: "/bench", labelKey: "nav.bench", icon: ENTITY_ICON.bench },
  // Logs carry every caller's full conversation payload, so reading them is an
  // admin capability.
  { id: "logs", path: "/logs", labelKey: "nav.logs", icon: ENTITY_ICON.log, adminOnly: true },
  { id: "activeRequests", path: "/active-requests", labelKey: "nav.activeRequests", icon: ENTITY_ICON.activeRequest },
  { id: "users", path: "/users", labelKey: "nav.users", icon: ENTITY_ICON.user, adminOnly: true },
  { id: "check", path: CHECK_PATH, labelKey: "nav.check", icon: ENTITY_ICON.check, external: true },
  { id: "settings", path: "/settings", labelKey: "nav.settings", icon: ENTITY_ICON.settings, adminOnly: true },
];

/** Whether a route exists for a viewer: admin-only ones only for an admin. */
export const routeVisible = (route: RouteDef, isAdmin: boolean): boolean => !route.adminOnly || isAdmin;

/** A route's path relative to the Layout route ("/providers" -> "providers"). */
export const routeSegment = (route: RouteDef): string => route.path.slice(1);
