import { useState } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../lib/i18n";
import type { User } from "../types";

export function SetPassword() {
  const { t } = useI18n();
  const { user, setUser, logout } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError(t("setPassword.error.tooShort"));
    if (password !== confirm) return setError(t("setPassword.error.mismatch"));
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: User }>("/change-password", { newPassword: password });
      setUser(r.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("setPassword.error.fallback"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600/20 text-brand-400">
            <i className="bi bi-shield-lock text-2xl" />
          </span>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-ink-100">{t("setPassword.title")}</h1>
            <p className="text-sm text-ink-500">
              {t("setPassword.signedInAs", { username: user?.username ?? "" })}
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="card card-pad space-y-4">
          <div>
            <label className="label">{t("setPassword.form.newPassword")}</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus placeholder={t("setPassword.form.newPasswordPlaceholder")} autoComplete="new-password" />
          </div>
          <div>
            <label className="label">{t("setPassword.form.confirmPassword")}</label>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </div>
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              <i className="bi bi-exclamation-circle" />
              {error}
            </div>
          )}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-check-lg" />}
            {t("setPassword.form.submit")}
          </button>
          <button type="button" className="btn-ghost w-full btn-xs" onClick={() => void logout()}>
            <i className="bi bi-box-arrow-right" />
            {t("setPassword.form.signOut")}
          </button>
        </form>
      </div>
    </div>
  );
}
