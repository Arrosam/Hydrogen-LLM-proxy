import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { useAuth } from "../auth";
import { useI18n, type Language } from "../lib/i18n";
import { PageHeader } from "../components/Layout";
import { ErrorNote, Spinner, Toggle } from "../components/common";
import { useToast } from "../components/Toast";

interface EnvSettings {
  allowPrivateUpstreams: boolean;
  logPayloadMaxChars: number;
  simulatedStreamingTokenRate: number;
  sessionTtlMs: number;
  env: {
    nodeEnv: string;
    port: number;
    host: string;
    dataDir: string;
    adminUsername: string;
    cookieSecure: string;
  };
}

export function Settings() {
  const { t } = useI18n();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  return (
    <div>
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} icon="bi-gear" />
      {!isAdmin && (
        <ErrorNote message={t("settings.env.hint")} />
      )}
      <LanguageCard />
      <RetentionCard />
      <AllowlistCard />
      <EnvCard />
    </div>
  );
}

function LanguageCard() {
  const { t, language, setLanguage } = useI18n();
  const [busy, setBusy] = useState(false);

  const choose = async (lang: Language) => {
    if (lang === language) return;
    setBusy(true);
    try {
      await setLanguage(lang);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad mt-6">
      <div className="mb-1 flex items-center gap-2">
        <i className="bi bi-translate text-brand-400" />
        <h3 className="font-medium text-ink-100">{t("settings.language")}</h3>
      </div>
      <p className="mb-3 text-xs text-ink-500">{t("settings.language.hint")}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${language === "en" ? "bg-brand-600 text-white" : "border border-ink-700 bg-ink-900 text-ink-300 hover:text-ink-100"}`}
          onClick={() => void choose("en")}
          disabled={busy}
        >
          {t("settings.language.en")}
        </button>
        <button
          type="button"
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${language === "zh" ? "bg-brand-600 text-white" : "border border-ink-700 bg-ink-900 text-ink-300 hover:text-ink-100"}`}
          onClick={() => void choose("zh")}
          disabled={busy}
        >
          {t("settings.language.zh")}
        </button>
      </div>
    </div>
  );
}

function RetentionCard() {
  const { t } = useI18n();
  const toast = useToast();
  const { data, reload } = useAsync(() => api.get<{ days: number }>("/settings/log-retention"));
  const [days, setDays] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setDays(String(data.days));
  }, [data]);

  const save = async () => {
    const n = Number(days.trim() || "0");
    if (!Number.isInteger(n) || n < 0 || n > 3650) {
      toast.error("Days must be a whole number between 0 and 3650");
      return;
    }
    setSaving(true);
    try {
      const r = await api.put<{ days: number; pruned: number }>("/settings/log-retention", { days: n });
      toast.success(
        n === 0
          ? "Auto-prune disabled — logs are kept forever"
          : `Keeping the last ${n} day${n === 1 ? "" : "s"}${r.pruned ? ` — removed ${r.pruned} old ${r.pruned === 1 ? "entry" : "entries"}` : ""}`,
      );
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card card-pad mt-6">
      <div className="mb-1 flex items-center gap-2">
        <i className="bi bi-clock-history text-brand-400" />
        <h3 className="font-medium text-ink-100">{t("settings.logRetention")}</h3>
      </div>
      <p className="mb-3 text-xs text-ink-500">{t("settings.logRetention.hint")}</p>
      <div className="flex items-center gap-2">
        <input
          className="input w-32 font-mono text-xs"
          inputMode="numeric"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          placeholder="0"
        />
        <span className="text-xs text-ink-500">{t("common.days")}</span>
        <button className="btn-ghost btn-xs whitespace-nowrap" onClick={save} disabled={saving}>
          {saving ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-check-lg" />}
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

function AllowlistCard() {
  const { t } = useI18n();
  const toast = useToast();
  const { data, reload } = useAsync(() => api.get<{ entries: string[] }>("/settings/upstream-allowlist"));
  const [entry, setEntry] = useState("");
  const [saving, setSaving] = useState(false);
  const entries = data?.entries ?? [];

  const put = async (next: string[]) => {
    setSaving(true);
    try {
      await api.put("/settings/upstream-allowlist", { entries: next });
      reload();
      toast.success("Allowlist updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const add = () => {
    const v = entry.trim();
    if (!v || entries.includes(v)) {
      setEntry("");
      return;
    }
    void put([...entries, v]).then(() => setEntry(""));
  };

  return (
    <div className="card card-pad mt-6">
      <div className="mb-1 flex items-center gap-2">
        <i className="bi bi-shield-lock text-brand-400" />
        <h3 className="font-medium text-ink-100">{t("settings.allowlist")}</h3>
      </div>
      <p className="mb-3 text-xs text-ink-500">{t("settings.allowlist.hint")}</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {entries.length === 0 && <span className="text-xs text-ink-600">{t("settings.allowlist.empty")}</span>}
        {entries.map((e) => (
          <span key={e} className="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 font-mono text-xs text-ink-200">
            {e}
            <button className="text-ink-500 hover:text-red-400" title="Remove" disabled={saving} onClick={() => void put(entries.filter((x) => x !== e))}>
              <i className="bi bi-x-lg" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="input font-mono text-xs"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={t("settings.allowlist.placeholder")}
        />
        <button className="btn-ghost btn-xs whitespace-nowrap" onClick={add} disabled={saving}>
          <i className="bi bi-plus-lg" />
          {t("common.add")}
        </button>
      </div>
    </div>
  );
}

function EnvCard() {
  const { t } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data, loading, error, reload } = useAsync(() => api.get<EnvSettings>("/settings/env"));

  const [allowPrivate, setAllowPrivate] = useState(false);
  const [logPayloadMaxChars, setLogPayloadMaxChars] = useState("");
  const [tokenRate, setTokenRate] = useState("");
  const [sessionTtlMs, setSessionTtlMs] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setAllowPrivate(data.allowPrivateUpstreams);
    setLogPayloadMaxChars(String(data.logPayloadMaxChars));
    setTokenRate(String(data.simulatedStreamingTokenRate));
    setSessionTtlMs(String(data.sessionTtlMs));
  }, [data]);

  const save = async () => {
    const lpmc = Number(logPayloadMaxChars.trim());
    const rate = Number(tokenRate.trim());
    const ttl = Number(sessionTtlMs.trim());
    if (!Number.isInteger(lpmc) || lpmc < 0 || lpmc > 10_000_000) {
      toast.error("Log payload max chars must be a whole number between 0 and 10000000");
      return;
    }
    if (!Number.isInteger(rate) || rate < 1) {
      toast.error("Simulated streaming token rate must be a positive integer");
      return;
    }
    if (!Number.isInteger(ttl) || ttl < 60_000) {
      toast.error("Session TTL must be at least 60000 ms");
      return;
    }
    setSaving(true);
    try {
      await api.put<EnvSettings>("/settings/env", {
        allowPrivateUpstreams: allowPrivate,
        logPayloadMaxChars: lpmc,
        simulatedStreamingTokenRate: rate,
        sessionTtlMs: ttl,
      });
      toast.success("Runtime settings saved");
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card card-pad mt-6">
      <div className="mb-1 flex items-center gap-2">
        <i className="bi bi-sliders text-brand-400" />
        <h3 className="font-medium text-ink-100">{t("settings.env")}</h3>
      </div>
      <p className="mb-4 text-xs text-ink-500">{t("settings.env.hint")}</p>

      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {data && (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <label className="label">{t("settings.env.allowPrivate")}</label>
              <p className="text-xs text-ink-500">{t("settings.env.allowPrivate.hint")}</p>
            </div>
            <Toggle checked={allowPrivate} onChange={setAllowPrivate} disabled={!isAdmin} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label">{t("settings.env.logPayloadMaxChars")}</label>
              <input
                className="input font-mono text-xs"
                inputMode="numeric"
                value={logPayloadMaxChars}
                onChange={(e) => setLogPayloadMaxChars(e.target.value)}
                disabled={!isAdmin}
              />
            </div>
            <div>
              <label className="label">{t("settings.env.simulatedStreamingTokenRate")}</label>
              <input
                className="input font-mono text-xs"
                inputMode="numeric"
                value={tokenRate}
                onChange={(e) => setTokenRate(e.target.value)}
                disabled={!isAdmin}
              />
            </div>
            <div>
              <label className="label">{t("settings.env.sessionTtlMs")}</label>
              <input
                className="input font-mono text-xs"
                inputMode="numeric"
                value={sessionTtlMs}
                onChange={(e) => setSessionTtlMs(e.target.value)}
                disabled={!isAdmin}
              />
            </div>
          </div>

          {isAdmin && (
            <div className="flex justify-end">
              <button className="btn-primary btn-xs" onClick={save} disabled={saving}>
                {saving ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-check-lg" />}
                {t("common.save")}
              </button>
            </div>
          )}

          <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <i className="bi bi-lock text-ink-500" />
              <span className="text-xs font-medium text-ink-300">{t("settings.env.bootOnly")}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <ReadonlyRow label={t("settings.env.nodeEnv")} value={data.env.nodeEnv} />
              <ReadonlyRow label={t("settings.env.port")} value={String(data.env.port)} />
              <ReadonlyRow label={t("settings.env.host")} value={data.env.host} />
              <ReadonlyRow label={t("settings.env.dataDir")} value={data.env.dataDir} />
              <ReadonlyRow label={t("settings.env.adminUsername")} value={data.env.adminUsername} />
              <ReadonlyRow label={t("settings.env.cookieSecure")} value={data.env.cookieSecure} />
            </div>
            <p className="mt-2 text-[11px] text-ink-600">Changing these requires editing the environment and restarting the proxy.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink-500">{label}</span>
      <code className="font-mono text-ink-300">{value}</code>
    </div>
  );
}
