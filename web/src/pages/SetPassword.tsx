import { useState } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import type { User } from "../types";

export function SetPassword() {
  const { user, setUser, logout } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: User }>("/change-password", { newPassword: password });
      setUser(r.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not set password");
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
            <h1 className="text-xl font-semibold text-ink-100">Create your password</h1>
            <p className="text-sm text-ink-500">
              Signed in as <span className="text-ink-300">{user?.username}</span>. Set a password to continue.
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="card card-pad space-y-4">
          <div>
            <label className="label">New password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus placeholder="at least 8 characters" autoComplete="new-password" />
          </div>
          <div>
            <label className="label">Confirm password</label>
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
            Set password and continue
          </button>
          <button type="button" className="btn-ghost w-full btn-xs" onClick={() => void logout()}>
            <i className="bi bi-box-arrow-right" />
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
