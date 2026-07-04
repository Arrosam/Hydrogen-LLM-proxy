import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { SetPassword } from "./pages/SetPassword";
import { Overview } from "./pages/Overview";
import { Providers } from "./pages/Providers";
import { Models } from "./pages/Models";
import { Mubs } from "./pages/Mubs";
import { Tokens } from "./pages/Tokens";
import { Users } from "./pages/Users";
import { Logs } from "./pages/Logs";

function FullSpinner() {
  return (
    <div className="flex h-screen items-center justify-center text-brand-400">
      <i className="bi bi-arrow-repeat animate-spin text-3xl" />
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <FullSpinner />;
  if (!user) return <Login />;
  if (user.mustChangePassword) return <SetPassword />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="providers" element={<Providers />} />
        <Route path="models" element={<Models />} />
        <Route path="mubs" element={<Mubs kind="resilience" />} />
        <Route path="micro-agents" element={<Mubs kind="chain" />} />
        <Route path="tokens" element={<Tokens />} />
        <Route path="users" element={<Users />} />
        <Route path="logs" element={<Logs />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
