import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth";
import { useI18n } from "../lib/i18n";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";
import { useToast } from "./Toast";
import type { User } from "../types";

interface NavItem {
  to: string;
  labelKey: string;
  icon: string;
  end?: boolean;
  /** Hidden from anyone who is not an admin. */
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: "/", labelKey: "nav.overview", icon: "bi-speedometer2", end: true },
  { to: "/services", labelKey: "nav.modelServices", icon: "bi-diagram-3" },
  { to: "/micro-agents", labelKey: "nav.microAgents", icon: "bi-robot" },
  { to: "/models", labelKey: "nav.models", icon: "bi-box" },
  { to: "/providers", labelKey: "nav.providers", icon: "bi-hdd-network" },
  { to: "/tokens", labelKey: "nav.tokens", icon: "bi-key" },
  { to: "/logs", labelKey: "nav.logs", icon: "bi-journal-text" },
  { to: "/active-requests", labelKey: "nav.activeRequests", icon: "bi-activity" },
  { to: "/users", labelKey: "nav.users", icon: "bi-people" },
  { to: "/settings", labelKey: "nav.settings", icon: "bi-gear", adminOnly: true },
];

export function Layout() {
  const { user, logout, setUser } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [pwOpen, setPwOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const changePassword = async () => {
    if (next.length < 8) return toast.error(t("layout.passwordTooShort"));
    if (next !== confirm) return toast.error(t("layout.passwordsDoNotMatch"));
    setBusy(true);
    try {
      const r = await api.post<{ user: User }>("/change-password", { currentPassword: current, newPassword: next });
      setUser(r.user);
      toast.success(t("layout.passwordChanged"));
      setPwOpen(false);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("layout.failed"));
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
            <div className="text-sm font-semibold text-ink-100">{t("brand.name")}</div>
            <div className="text-[11px] text-ink-500">{t("brand.subtitle")}</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {NAV.filter((n) => !n.adminOnly || user?.role === "admin").map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="nav-link">
              <i className={`bi ${n.icon} text-base`} />
              <span className="truncate">{t(n.labelKey)}</span>
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
              {t("layout.passwordButton")}
            </button>
            <button className="btn-ghost flex-1 btn-xs" onClick={() => void logout()}>
              <i className="bi bi-box-arrow-right" />
              {t("layout.signOut")}
            </button>
          </div>
        </div>
      </aside>

      <Modal
        open={pwOpen}
        title={t("layout.changePasswordTitle")}
        icon="bi-key"
        onClose={() => setPwOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setPwOpen(false)}>{t("common.cancel")}</button>
            <button className="btn-primary" onClick={changePassword} disabled={busy}>
              <i className="bi bi-check-lg" />
              {t("common.update")}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label">{t("layout.currentPassword")}</label>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </div>
          <div>
            <label className="label">{t("layout.newPassword")}</label>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder={t("layout.passwordPlaceholder")} autoComplete="new-password" />
          </div>
          <div>
            <label className="label">{t("layout.confirmNewPassword")}</label>
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
