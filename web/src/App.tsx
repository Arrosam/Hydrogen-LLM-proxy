import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { SetPassword } from "./pages/SetPassword";
import { Overview } from "./pages/Overview";
import { Providers } from "./pages/Providers";
import { Models } from "./pages/Models";
import { ModelServices } from "./pages/ModelServices";
import { Tokens } from "./pages/Tokens";
import { Users } from "./pages/Users";
import { Logs } from "./pages/Logs";
import { ModelBench } from "./pages/ModelBench";
import { ActiveRequests } from "./pages/ActiveRequests";
import { Settings } from "./pages/Settings";
import { Check } from "./pages/Check";

function FullSpinner() {
  return (
    <div className="flex h-screen items-center justify-center text-brand-400">
      <i className="bi bi-arrow-repeat animate-spin text-3xl" />
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      {/* Public route: API key check, no login required */}
      <Route path="/check" element={<Check />} />

      {/* Authenticated routes */}
      <Route
        element={
          loading ? <FullSpinner /> : !user ? <Login /> : user.mustChangePassword ? <SetPassword /> : <Layout />
        }
      >
        <Route index element={<Overview />} />
        <Route path="providers" element={<Providers />} />
        {/* Singular, and it must stay singular: the fuzzy endpoint adapter rewrites
            any path ending "/models" onto the proxy's /v1/models, so a SPA route
            spelled "/models" never survives a hard load (refresh, bookmark, pasted
            URL). "/model" is not in that suffix table. See server/src/transport/fuzzyUrl.ts. */}
        <Route path="model" element={<Models />} />
        {/* Anything still aimed at the old path from inside the app -- browser
            Back onto a pre-rename history entry, a stale link -- lands here
            instead of on the catch-all's silent bounce to Overview. A hard
            GET /models never reaches the SPA at all: the rewriter takes it. */}
        <Route path="models" element={<Navigate to="/model" replace />} />
        <Route path="services" element={<ModelServices kind="resilience" />} />
        <Route path="micro-agents" element={<ModelServices kind="chain" />} />
        <Route path="tokens" element={<Tokens />} />
        <Route path="bench" element={<ModelBench />} />
        <Route path="active-requests" element={<ActiveRequests />} />
        {/* Users, Settings, and Logs are admin-only. Hiding the nav link is
            presentation; this is what makes typing the URL not work. The server
            enforces it too. (Logs carry every caller's full conversation
            payload, so reading them is an admin capability.) */}
        {user?.role === "admin" && <Route path="logs" element={<Logs />} />}
        {user?.role === "admin" && <Route path="users" element={<Users />} />}
        {user?.role === "admin" && <Route path="settings" element={<Settings />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
