import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth, useIsAdmin } from "./auth";
import { Spinner } from "./components/common";
import { Layout } from "./components/Layout";
import { CHECK_PATH, HOME_PATH, LEGACY_MODELS_SEGMENT, MODELS_PATH, ROUTES, routeSegment, routeVisible, type RouteId } from "./lib/routes";
import { SERVICE_KIND } from "./lib/serviceDef";
import { Login } from "./pages/Login";
import { SetPassword } from "./pages/SetPassword";
import { Overview } from "./pages/Overview";
import { Providers } from "./pages/Providers";
import { Proxies } from "./pages/Proxies";
import { Models } from "./pages/Models";
import { ModelServices } from "./pages/ModelServices";
import { Tokens } from "./pages/Tokens";
import { Users } from "./pages/Users";
import { Logs } from "./pages/Logs";
import { ModelBench } from "./pages/ModelBench";
import { ActiveRequests } from "./pages/ActiveRequests";
import { Settings } from "./pages/Settings";
import { Check } from "./pages/Check";
import { Tools } from "./pages/Tools";

/** What each entry of the route table renders. */
const PAGES: Record<RouteId, ReactElement> = {
  overview: <Overview />,
  services: <ModelServices kind={SERVICE_KIND.resilience} />,
  microAgents: <ModelServices kind={SERVICE_KIND.chain} />,
  tools: <Tools />,
  models: <Models />,
  providers: <Providers />,
  proxies: <Proxies />,
  tokens: <Tokens />,
  bench: <ModelBench />,
  logs: <Logs />,
  activeRequests: <ActiveRequests />,
  users: <Users />,
  check: <Check />,
  settings: <Settings />,
};

export default function App() {
  const { user, loading } = useAuth();
  const isAdmin = useIsAdmin();

  return (
    <Routes>
      {/* Public route: API key check, no login required */}
      <Route path={CHECK_PATH} element={PAGES.check} />

      {/* Authenticated routes */}
      <Route
        element={
          loading ? <Spinner fullScreen /> : !user ? <Login /> : user.mustChangePassword ? <SetPassword /> : <Layout />
        }
      >
        {/* Admin-only entries are left out for everyone else: that, not the
            hidden nav link, is what makes typing the URL not work. */}
        {ROUTES.filter((r) => !r.external && routeVisible(r, isAdmin)).map((r) =>
          r.path === HOME_PATH ? (
            <Route key={r.id} index element={PAGES[r.id]} />
          ) : (
            <Route key={r.id} path={routeSegment(r)} element={PAGES[r.id]} />
          ),
        )}
        {/* Anything still aimed at the old path from inside the app -- browser
            Back onto a pre-rename history entry, a stale link -- lands here
            instead of on the catch-all's silent bounce to Overview. A hard
            GET /models never reaches the SPA at all: the rewriter takes it. */}
        <Route path={LEGACY_MODELS_SEGMENT} element={<Navigate to={MODELS_PATH} replace />} />
        <Route path="*" element={<Navigate to={HOME_PATH} replace />} />
      </Route>
    </Routes>
  );
}
