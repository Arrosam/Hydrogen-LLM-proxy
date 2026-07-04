import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";
import { useToast } from "./Toast";
import type { User } from "../types";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: "bi-speedometer2", end: true },
  { to: "/mubs", label: "Model Services", icon: "bi-diagram-3" },
  { to: "/micro-agents", label: "Micro Agents", icon: "bi-robot" },
  { to: "/models", label: "Models", icon: "bi-box" },
  { to: "/providers", label: "Providers", icon: "bi-hdd-network" },
  { to: "/tokens", label: "Tokens", icon: "bi-key" },
  { to: "/logs", label: "Logs", icon: "bi-journal-text" },
  { to: "/users", label: "Users", icon: "bi-people" },
];

export function Layout() {
  const { user, logout, setUser } = useAuth();
  const toast = useToast();
  const [pwOpen, setPwOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const changePassword = async () => {
    if (next.length < 8) return toast.error("New password must be at least 8 characters");
    if (next !== confirm) return toast.error("Passwords do not match");
    setBusy(true);
    try {
      const r = await api.post<{ user: User }>("/change-password", { currentPassword: current, newPassword: next });
      setUser(r.user);
      toast.success("Password changed");
      setPwOpen(false);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900/60">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600/20 text-brand-400">
            <i className="bi bi-lightning-charge-fill text-lg" />
          </span>
          <div>
            <div className="text-sm font-semibold text-ink-100">Hydrogen</div>
            <div className="text-[11px] text-ink-500">LLM Proxy</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="nav-link">
              <i className={`bi ${n.icon} text-base`} />
              <span className="truncate">{n.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-ink-800 px-4 py-3">
          <div className="mb-2 flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-800 text-ink-300">
              <i className="bi bi-person-fill" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink-100">{user?.username}</div>
              <span className={user?.role === "admin" ? "badge-blue" : "badge-gray"}>
                <i className={`bi ${user?.role === "admin" ? "bi-shield-lock" : "bi-person-gear"}`} />
                {user?.role}
              </span>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button className="btn-ghost flex-1 btn-xs" onClick={() => setPwOpen(true)}>
              <i className="bi bi-key" />
              Password
            </button>
            <button className="btn-ghost flex-1 btn-xs" onClick={() => void logout()}>
              <i className="bi bi-box-arrow-right" />
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <Modal
        open={pwOpen}
        title="Change password"
        icon="bi-key"
        onClose={() => setPwOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setPwOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={changePassword} disabled={busy}>
              <i className="bi bi-check-lg" />
              Update
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label">Current password</label>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </div>
          <div>
            <label className="label">New password</label>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="at least 8 characters" autoComplete="new-password" />
          </div>
          <div>
            <label className="label">Confirm new password</label>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </div>
        </div>
      </Modal>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  icon,
  action,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold text-ink-100">
          {icon && <i className={`bi ${icon} text-brand-400`} />}
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-ink-400">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
