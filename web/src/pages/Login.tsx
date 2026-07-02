import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { api } from "../api";

export function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<{ username: string; password: string } | null>(null);

  useEffect(() => {
    api
      .get<{ initial: { username: string; password: string } | null }>("/setup-info")
      .then((r) => {
        if (r.initial) {
          setHint(r.initial);
          setUsername((u) => u || r.initial!.username);
          setPassword((p) => p || r.initial!.password);
        }
      })
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600/20 text-brand-400">
            <i className="bi bi-lightning-charge-fill text-2xl" />
          </span>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-ink-100">Hydrogen</h1>
            <p className="text-sm text-ink-500">Sign in to the LLM proxy console</p>
          </div>
        </div>

        {hint && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-brand-700/40 bg-brand-700/10 px-3 py-2.5 text-sm text-ink-200">
            <i className="bi bi-info-circle-fill mt-0.5 text-brand-400" />
            <div>
              First time here? Sign in with username{" "}
              <code className="rounded bg-ink-950 px-1 font-mono text-brand-400">{hint.username}</code> and
              password <code className="rounded bg-ink-950 px-1 font-mono text-brand-400">{hint.password}</code>.
              You'll set your own password next.
            </div>
          </div>
        )}

        <form onSubmit={submit} className="card card-pad space-y-4">
          <div>
            <label className="label">Username</label>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              <i className="bi bi-exclamation-circle" />
              {error}
            </div>
          )}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-box-arrow-in-right" />}
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
