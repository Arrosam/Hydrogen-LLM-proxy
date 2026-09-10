import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api";
import { HydrogenLogo } from "../components/Logo";
import { useI18n } from "../lib/i18n";
import { formatDate, formatNumber } from "../lib/format";

interface KeyStatus {
  valid: boolean;
  expired: boolean;
  requestsExceeded: boolean;
  tokensExceeded: boolean;
  checkedAt: number;
}

interface CheckResult {
  key: {
    id: number;
    name: string;
    keyPrefix: string;
    scopeServices: number[] | null;
    maxRequests: number | null;
    maxTokens: number | null;
    usedRequests: number;
    usedTokens: number;
    expiresAt: number | null;
    enabled: boolean;
    createdAt: number;
  };
  status: KeyStatus;
}

const REFRESH_INTERVAL = 5000;

async function checkKey(apiKey: string): Promise<CheckResult> {
  const res = await fetch("/admin/api/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    if (data && typeof data === "object" && "error" in data) {
      message = String((data as { error: unknown }).error);
    }
    throw new ApiError(res.status, message, data);
  }
  return data as CheckResult;
}

function ProgressBar({ used, max, label }: { used: number; max: number | null; label: string }) {
  const { t } = useI18n();
  const pct = max && max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const remaining = max != null ? Math.max(0, max - used) : null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-ink-300">{label}</span>
        <span className="font-mono text-xs text-ink-400">
          {formatNumber(used)}
          {max != null ? ` / ${formatNumber(max)}` : ` · ${t("check.unlimited")}`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ink-800">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-brand-500"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {remaining != null && (
        <div className="mt-0.5 text-right text-xs text-ink-500">
          {t("check.remaining", { count: formatNumber(remaining) })}
        </div>
      )}
    </div>
  );
}

export function Check() {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [submittedKey, setSubmittedKey] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOnce = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await checkKey(key);
      setResult(r);
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : t("check.error.fetchFailed"));
      if (e instanceof ApiError && e.status === 401) {
        // key is invalid — stop polling
        setSubmittedKey(null);
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setSubmittedKey(apiKey.trim());
    fetchOnce(apiKey.trim());
  };

  // Poll every 5 seconds when a key is submitted
  useEffect(() => {
    if (!submittedKey) return;
    timerRef.current = setInterval(() => fetchOnce(submittedKey), REFRESH_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [submittedKey, fetchOnce]);

  const reset = () => {
    setSubmittedKey(null);
    setResult(null);
    setError(null);
    setApiKey("");
  };

  const key = result?.key;
  const status = result?.status;

  return (
    <div className="min-h-screen bg-ink-950 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HydrogenLogo className="h-12 w-12" />
            <div>
              <h1 className="text-lg font-semibold text-ink-100">{t("check.title")}</h1>
              <p className="text-sm text-ink-500">{t("check.subtitle")}</p>
            </div>
          </div>
          <Link to="/" className="btn-ghost btn-sm">
            <i className="bi bi-house" />
            {t("check.backToDashboard")}
          </Link>
        </div>

        {/* Input form */}
        {!submittedKey && (
          <form onSubmit={submit} className="card card-pad space-y-4">
            <div>
              <label className="label">{t("check.form.apiKey")}</label>
              <input
                className="input font-mono"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoFocus
                autoComplete="off"
              />
            </div>
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
                <i className="bi bi-exclamation-circle" />
                {error}
              </div>
            )}
            <button className="btn-primary w-full" disabled={!apiKey.trim() || loading}>
              {loading ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-search" />}
              {t("check.form.submit")}
            </button>
          </form>
        )}

        {/* Result */}
        {submittedKey && (
          <div className="space-y-4">
            {/* Key bar */}
            <div className="card card-pad flex items-center justify-between">
              <div className="flex items-center gap-2">
                <code className="rounded bg-ink-950 px-2 py-1 font-mono text-xs text-brand-400">
                  {key?.keyPrefix ?? submittedKey.slice(0, 14)}...
                </code>
                {key && <span className="text-sm text-ink-300">{key.name}</span>}
              </div>
              <button className="btn-ghost btn-xs" onClick={reset}>
                <i className="bi bi-arrow-left" />
                {t("check.action.checkAnother")}
              </button>
            </div>

            {/* Loading state (initial) */}
            {loading && !result && !error && (
              <div className="card card-pad flex items-center justify-center gap-2 py-12 text-ink-400">
                <i className="bi bi-arrow-repeat animate-spin text-xl" />
                <span className="text-sm">{t("check.loading")}</span>
              </div>
            )}

            {/* Error */}
            {error && !result && (
              <div className="card card-pad">
                <div className="flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
                  <i className="bi bi-exclamation-octagon-fill" />
                  {error}
                </div>
              </div>
            )}

            {/* Status cards */}
            {key && status && (
              <>
                {/* Overall status */}
                <div className={`card card-pad flex items-center gap-3 ${status.valid ? "border-green-800/50" : "border-red-800/50"}`}>
                  <span className={`flex h-10 w-10 items-center justify-center rounded-full ${status.valid ? "bg-green-950/50 text-green-400" : "bg-red-950/50 text-red-400"}`}>
                    <i className={`bi ${status.valid ? "bi-check-circle-fill" : "bi-x-circle-fill"} text-xl`} />
                  </span>
                  <div>
                    <div className="text-sm font-medium text-ink-100">
                      {status.valid ? t("check.status.valid") : t("check.status.invalid")}
                    </div>
                    {!status.valid && (
                      <div className="text-xs text-ink-400">
                        {status.expired && t("check.status.expired")}
                        {status.requestsExceeded && t("check.status.requestsExceeded")}
                        {status.tokensExceeded && t("check.status.tokensExceeded")}
                      </div>
                    )}
                  </div>
                  {!status.valid && !key.enabled && (
                    <span className="badge-red ml-auto"><i className="bi bi-pause-circle" />{t("check.status.disabled")}</span>
                  )}
                </div>

                {/* Usage */}
                <div className="card card-pad space-y-4">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-100">
                    <i className="bi bi-graph-up text-brand-400" />
                    {t("check.section.usage")}
                  </h3>
                  <ProgressBar used={key.usedRequests} max={key.maxRequests} label={t("check.usage.requests")} />
                  <ProgressBar used={key.usedTokens} max={key.maxTokens} label={t("check.usage.tokens")} />
                </div>

                {/* Details */}
                <div className="card card-pad space-y-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-100">
                    <i className="bi bi-info-circle text-brand-400" />
                    {t("check.section.details")}
                  </h3>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-ink-400">{t("check.details.name")}</dt>
                      <dd className="text-ink-100">{key.name}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-ink-400">{t("check.details.enabled")}</dt>
                      <dd className={key.enabled ? "text-green-400" : "text-red-400"}>
                        {key.enabled ? t("common.yes") : t("common.no")}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-ink-400">{t("check.details.scope")}</dt>
                      <dd className="text-ink-100">
                        {!key.scopeServices || key.scopeServices.length === 0
                          ? t("check.details.allServices")
                          : t("check.details.serviceCount", { count: key.scopeServices.length })}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-ink-400">{t("check.details.expires")}</dt>
                      <dd className="text-ink-100">
                        {key.expiresAt ? formatDate(key.expiresAt) : t("common.never")}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-ink-400">{t("check.details.created")}</dt>
                      <dd className="text-ink-100">{formatDate(key.createdAt)}</dd>
                    </div>
                  </dl>
                </div>

                {/* Live indicator */}
                <div className="flex items-center justify-center gap-1.5 text-xs text-ink-500">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" />
                  </span>
                  {t("check.liveUpdate", { seconds: REFRESH_INTERVAL / 1000 })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
