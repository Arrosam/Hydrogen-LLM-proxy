import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { useI18n, type Language } from "../lib/i18n";
import { PageHeader } from "../components/Layout";
import { HydrogenLogo } from "../components/Logo";
import { ErrorNote, Spinner, Toggle, useConfirm } from "../components/common";
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

/** Admin-only: the route and every settings endpoint are gated to admins, so
 * this page never has to render a read-only variant of itself. */
export function Settings() {
  const { t } = useI18n();

  return (
    <div>
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} icon="bi-gear" />
      <UpdateCard />
      <LanguageCard />
      <BackupCard />
      <RetentionCard />
      <ImageCacheCard />
      <AllowlistCard />
      <EnvCard />
      <AboutFooter />
    </div>
  );
}

/** The running server's release, reported by the server itself so a stale
 * cached bundle can never claim a version the server isn't running. */
function AboutFooter() {
  const { data } = useAsync(() => api.get<{ version: string }>("/settings/version"));
  return (
    <div className="mt-10 flex items-center justify-center gap-2 pb-2 text-xs text-ink-500">
      <HydrogenLogo className="h-4 w-4" />
      <span className="font-medium text-ink-400">Hydrogen</span>
      {data && <span className="font-mono">v{data.version}</span>}
      <span className="text-ink-600">·</span>
      <span>LLM Proxy</span>
    </div>
  );
}

interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  checkedAt: number;
  runtime: "kubernetes" | "docker" | "node";
  restartSupported: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Version check against GitHub releases, plus an operator-enabled supervised
 * restart. After a restart the card verifies the exact requested release;
 * unchanged, intermediate, and downgraded versions all fall back to honest
 * manual deployment guidance. */
function UpdateCard() {
  const { t } = useI18n();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();

  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartMismatch, setRestartMismatch] = useState(false);

  const check = async (refresh: boolean) => {
    setChecking(true);
    try {
      const s = await api.get<UpdateStatus>(`/update/check${refresh ? "?refresh=1" : ""}`);
      setStatus(s);
      setCheckError(s.error ?? null);
      if (!s.updateAvailable) setRestartMismatch(false);
    } catch (e) {
      setCheckError(e instanceof ApiError ? e.message : t("settings.update.toast.checkFailed"));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const upgrade = async () => {
    if (!status?.latest || !status.restartSupported) return;
    const target = status.latest;
    const ok = await confirm(
      t("settings.update.confirm.title", { version: target }),
      t("settings.update.confirm.body"),
    );
    if (!ok) return;

    const before = status.current;
    setRestarting(true);
    setRestartMismatch(false);
    try {
      await api.post("/update/restart");
    } catch (e) {
      setRestarting(false);
      toast.error(e instanceof ApiError ? e.message : t("common.saveFailed"));
      return;
    }

    // Wait out the shutdown, then poll until the server answers again.
    await sleep(3000);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const s = await api.get<UpdateStatus>("/update/check");
        setStatus(s);
        setRestarting(false);
        if (s.current === target) {
          toast.success(t("settings.update.toast.upgraded", { version: s.current }));
        } else {
          setRestartMismatch(true);
          toast.error(
            s.current === before
              ? t("settings.update.toast.sameVersion", { version: s.current })
              : t("settings.update.toast.unexpectedVersion", { actual: s.current, expected: target }),
          );
        }
        return;
      } catch {
        await sleep(2500);
      }
    }
    setRestarting(false);
    setRestartMismatch(true);
    toast.error(t("settings.update.toast.timeout"));
  };

  const publishedDate = status?.publishedAt ? new Date(status.publishedAt).toLocaleDateString() : null;

  return (
    <div className="card card-pad mt-6">
      <div className="mb-1 flex items-center gap-2">
        <i className="bi bi-cloud-arrow-down text-brand-400" />
        <h3 className="font-medium text-ink-100">{t("settings.update")}</h3>
      </div>
      <p className="mb-3 text-xs text-ink-500">{t("settings.update.hint")}</p>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-ink-500">{t("settings.update.current")}</span>
        <code className="rounded-md border border-ink-700 bg-ink-900 px-2 py-0.5 font-mono text-xs text-ink-200">
          {status ? `v${status.current}` : "…"}
        </code>
        {status && !status.error && !restarting && (
          status.updateAvailable ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
              <i className="bi bi-arrow-up-circle" />
              {t("settings.update.available", { version: status.latest ?? "?" })}
              {publishedDate && <span className="text-amber-400/70">· {t("settings.update.publishedAt", { date: publishedDate })}</span>}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
              <i className="bi bi-check-circle" />
              {t("settings.update.upToDate")}
            </span>
          )
        )}
        {restarting && (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-300">
            <i className="bi bi-arrow-repeat animate-spin" />
            {t("settings.update.restarting")}
          </span>
        )}
      </div>

      {checkError && <p className="mt-2 text-xs text-red-400">{checkError}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-ghost btn-xs" onClick={() => void check(true)} disabled={checking || restarting}>
          {checking ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-arrow-clockwise" />}
          {t("settings.update.checkNow")}
        </button>
        {status?.updateAvailable && status.releaseUrl && (
          <a className="btn-ghost btn-xs" href={status.releaseUrl} target="_blank" rel="noreferrer">
            <i className="bi bi-box-arrow-up-right" />
            {t("settings.update.releaseNotes")}
          </a>
        )}
        {status?.updateAvailable && status.restartSupported && (
          <button className="btn-primary btn-xs" onClick={() => void upgrade()} disabled={restarting}>
            {restarting ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-cloud-arrow-down" />}
            {t("settings.update.upgradeAction")}
          </button>
        )}
      </div>

      {status?.updateAvailable && (!status.restartSupported || restartMismatch) && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-ink-300">
          <p className="mb-2">
            {t(status.restartSupported ? "settings.update.manual.mismatch" : "settings.update.manual.disabled")}
          </p>
          {status.runtime === "docker" && (
            <div className="space-y-2">
              <div>
                <p className="mb-1 text-ink-500">{t("settings.update.manual.docker.image")}</p>
                <code className="block rounded bg-ink-950 px-2 py-1 font-mono text-[11px] text-ink-200">
                  docker compose pull && docker compose up -d
                </code>
              </div>
              <div>
                <p className="mb-1 text-ink-500">{t("settings.update.manual.docker.source")}</p>
                <code className="block rounded bg-ink-950 px-2 py-1 font-mono text-[11px] text-ink-200">
                  git pull && docker compose up -d --build
                </code>
              </div>
            </div>
          )}
          {status.runtime === "kubernetes" && (
            <p>{t("settings.update.manual.kubernetes", { version: status.latest ?? "?" })}</p>
          )}
          {status.runtime === "node" && (
            <p>{t("settings.update.manual.node", { version: status.latest ?? "?" })}</p>
          )}
          <p className="mt-2 text-ink-500">{t("settings.update.manual.pinned")}</p>
        </div>
      )}
      {confirmEl}
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

/** Row counts the server reports back after a restore, keyed by table name. */
type RestoreReport = {
  ok: true;
  restored: Record<string, number>;
  includedLogs: boolean;
  includedImageCache: boolean;
  providerKeysRestored: number;
};

/** Save `text` to the user's disk as `filename`, without a server round-trip. */
function downloadFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** `hydrogen-backup-2026-07-17.json` — dated so successive backups don't collide. */
function backupFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `hydrogen-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

const MIN_PASSPHRASE = 8;

/**
 * Export the whole instance to one file, and put it back later.
 *
 * The passphrase is the point, not a formality: provider API keys are encrypted
 * with a master key that lives on the server, so the package re-seals them under
 * this passphrase to be restorable anywhere. Nothing on the server can recover
 * it, which is worth saying plainly in the UI rather than discovering later.
 */
function BackupCard() {
  const { t } = useI18n();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();

  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [includeLogs, setIncludeLogs] = useState(true);
  // Off by default, like the server: the descriptions are regenerable, and the
  // cache can be the largest thing in the package.
  const [includeImageCache, setIncludeImageCache] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoring, setRestoring] = useState(false);

  const runExport = async () => {
    if (passphrase.length < MIN_PASSPHRASE) {
      toast.error(t("settings.backup.toast.passphraseTooShort", { min: MIN_PASSPHRASE }));
      return;
    }
    if (passphrase !== confirmPassphrase) {
      toast.error(t("settings.backup.toast.passphraseMismatch"));
      return;
    }
    setExporting(true);
    try {
      const r = await api.post<{ backup: unknown }>("/backup/export", { passphrase, includeLogs, includeImageCache });
      downloadFile(backupFilename(), JSON.stringify(r.backup));
      toast.success(t("settings.backup.toast.exported"));
      setPassphrase("");
      setConfirmPassphrase("");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("settings.backup.toast.exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  const runRestore = async () => {
    if (!file) return;
    if (!restorePassphrase) {
      toast.error(t("settings.backup.toast.passphraseRequired"));
      return;
    }
    const ok = await confirm(t("settings.backup.confirm.title"), t("settings.backup.confirm.body", { file: file.name }));
    if (!ok) return;

    setRestoring(true);
    try {
      const text = await file.text();
      let backup: unknown;
      try {
        backup = JSON.parse(text);
      } catch {
        toast.error(t("settings.backup.toast.notJson"));
        return;
      }
      const r = await api.post<RestoreReport>("/backup/restore", { passphrase: restorePassphrase, backup });
      const rows = Object.values(r.restored).reduce((a, b) => a + b, 0);
      toast.success(t("settings.backup.toast.restored", { rows }));
      // The server has ended this session — the users table it authenticated
      // against no longer exists. Reload straight into the login screen.
      setTimeout(() => window.location.assign("/"), 1200);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("settings.backup.toast.restoreFailed"));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="card card-pad mt-6">
      <div className="mb-1 flex items-center gap-2">
        <i className="bi bi-archive text-brand-400" />
        <h3 className="font-medium text-ink-100">{t("settings.backup")}</h3>
      </div>
      <p className="mb-4 text-xs text-ink-500">{t("settings.backup.hint")}</p>

      {/* Export */}
      <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-4">
        <div className="mb-1 flex items-center gap-2">
          <i className="bi bi-download text-ink-400" />
          <h4 className="text-sm font-medium text-ink-200">{t("settings.backup.export")}</h4>
        </div>
        <p className="mb-3 text-xs text-ink-500">{t("settings.backup.export.hint")}</p>

        <div className="grid max-w-xl gap-2 sm:grid-cols-2">
          <div>
            <label className="label">{t("settings.backup.passphrase")}</label>
            <input
              type="password"
              autoComplete="new-password"
              className="input text-xs"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={t("settings.backup.passphrase.placeholder")}
            />
          </div>
          <div>
            <label className="label">{t("settings.backup.passphraseConfirm")}</label>
            <input
              type="password"
              autoComplete="new-password"
              className="input text-xs"
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              placeholder={t("settings.backup.passphrase.placeholder")}
            />
          </div>
        </div>

        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-400/90">
          <i className="bi bi-exclamation-triangle mt-0.5" />
          <span>{t("settings.backup.passphrase.warning")}</span>
        </p>

        <div className="mt-3 flex items-center gap-2">
          <Toggle checked={includeLogs} onChange={setIncludeLogs} />
          <span className="text-xs text-ink-300">{t("settings.backup.includeLogs")}</span>
          <span className="text-xs text-ink-500">{t("settings.backup.includeLogs.hint")}</span>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <Toggle checked={includeImageCache} onChange={setIncludeImageCache} />
          <span className="text-xs text-ink-300">{t("settings.backup.includeImageCache")}</span>
          <span className="text-xs text-ink-500">{t("settings.backup.includeImageCache.hint")}</span>
        </div>

        <button className="btn-primary btn-xs mt-4" onClick={runExport} disabled={exporting}>
          {exporting ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-download" />}
          {t("settings.backup.exportAction")}
        </button>
      </div>

      {/* Restore */}
      <div className="mt-4 rounded-lg border border-ink-800 bg-ink-950/40 p-4">
        <div className="mb-1 flex items-center gap-2">
          <i className="bi bi-upload text-ink-400" />
          <h4 className="text-sm font-medium text-ink-200">{t("settings.backup.restore")}</h4>
        </div>
        <p className="mb-3 text-xs text-ink-500">{t("settings.backup.restore.hint")}</p>

        <div className="grid max-w-xl gap-2 sm:grid-cols-2">
          <div>
            <label className="label">{t("settings.backup.file")}</label>
            <input
              type="file"
              accept="application/json,.json"
              className="input text-xs file:mr-2 file:rounded file:border-0 file:bg-ink-800 file:px-2 file:py-0.5 file:text-xs file:text-ink-200"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <label className="label">{t("settings.backup.passphrase")}</label>
            <input
              type="password"
              autoComplete="off"
              className="input text-xs"
              value={restorePassphrase}
              onChange={(e) => setRestorePassphrase(e.target.value)}
              placeholder={t("settings.backup.passphrase.restorePlaceholder")}
            />
          </div>
        </div>

        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-400/90">
          <i className="bi bi-exclamation-triangle mt-0.5" />
          <span>{t("settings.backup.restore.warning")}</span>
        </p>

        <button className="btn-ghost btn-xs mt-4" onClick={runRestore} disabled={restoring || !file}>
          {restoring ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-upload" />}
          {t("settings.backup.restoreAction")}
        </button>
      </div>
      {confirmEl}
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
      toast.error(t("settings.logRetention.toast.invalidDays"));
      return;
    }
    setSaving(true);
    try {
      const r = await api.put<{ days: number; pruned: number }>("/settings/log-retention", { days: n });
      toast.success(
        n === 0
          ? t("settings.logRetention.toast.disabled")
          : r.pruned
            ? t("settings.logRetention.toast.savedPruned", { days: n, pruned: r.pruned })
            : t("settings.logRetention.toast.saved", { days: n }),
      );
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.saveFailed"));
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

const MIB = 1024 * 1024;

/** Bytes as MiB for display: whole numbers stay whole, odd values keep enough
 * precision to be recognisable rather than rounding to "0". */
function toMib(bytes: number): string {
  const mib = bytes / MIB;
  if (Number.isInteger(mib)) return String(mib);
  return mib.toFixed(mib < 10 ? 2 : 1);
}

type ImageCacheState = { maxBytes: number; entries: number; usedBytes: number };

/**
 * The OCR image cache: a Micro Agent's image-translation pre-pass remembers each
 * image's description by content hash, so a repeat of the same image never
 * reaches the model. The budget is what stops that from growing without end —
 * when it is exceeded, least-recently-used entries are evicted first.
 */
function ImageCacheCard() {
  const { t } = useI18n();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const { data, loading, error, reload } = useAsync(() => api.get<ImageCacheState>("/settings/image-cache"));
  const [mib, setMib] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (data) setMib(toMib(data.maxBytes));
  }, [data]);

  const save = async () => {
    const n = Number(mib.trim());
    if (!Number.isFinite(n) || n < 0 || n > 65536) {
      toast.error(t("settings.imageCache.toast.invalidSize"));
      return;
    }
    setSaving(true);
    try {
      const r = await api.put<ImageCacheState & { evicted: number }>("/settings/image-cache", { maxBytes: Math.round(n * MIB) });
      toast.success(
        n === 0
          ? t("settings.imageCache.toast.disabled")
          : r.evicted
            ? t("settings.imageCache.toast.savedEvicted", { size: toMib(r.maxBytes), evicted: r.evicted })
            : t("settings.imageCache.toast.saved", { size: toMib(r.maxBytes) }),
      );
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    const ok = await confirm(t("settings.imageCache.confirm.title"), t("settings.imageCache.confirm.body"));
    if (!ok) return;
    setClearing(true);
    try {
      const r = await api.del<{ cleared: number }>("/settings/image-cache");
      toast.success(t("settings.imageCache.toast.cleared", { cleared: r.cleared }));
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.saveFailed"));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="card card-pad mt-6">
      <div className="mb-1 flex items-center gap-2">
        <i className="bi bi-images text-brand-400" />
        <h3 className="font-medium text-ink-100">{t("settings.imageCache")}</h3>
      </div>
      <p className="mb-3 text-xs text-ink-500">{t("settings.imageCache.hint")}</p>

      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input w-32 font-mono text-xs"
              inputMode="decimal"
              value={mib}
              onChange={(e) => setMib(e.target.value)}
              placeholder="64"
            />
            <span className="text-xs text-ink-500">{t("settings.imageCache.unit")}</span>
            <button className="btn-ghost btn-xs whitespace-nowrap" onClick={save} disabled={saving}>
              {saving ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-check-lg" />}
              {t("common.save")}
            </button>
            <button className="btn-ghost btn-xs whitespace-nowrap" onClick={clear} disabled={clearing || data.entries === 0}>
              {clearing ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-trash" />}
              {t("settings.imageCache.clear")}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {data.maxBytes === 0
              ? t("settings.imageCache.off")
              : t("settings.imageCache.usage", {
                  used: toMib(data.usedBytes),
                  max: toMib(data.maxBytes),
                  entries: data.entries.toLocaleString(),
                })}
          </p>
        </>
      )}
      {confirmEl}
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
      toast.success(t("settings.allowlist.toast.updated"));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.saveFailed"));
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
            <button className="text-ink-500 hover:text-red-400" title={t("common.remove")} disabled={saving} onClick={() => void put(entries.filter((x) => x !== e))}>
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
      toast.error(t("settings.env.toast.invalidLogPayloadMaxChars"));
      return;
    }
    if (!Number.isInteger(rate) || rate < 1) {
      toast.error(t("settings.env.toast.invalidTokenRate"));
      return;
    }
    if (!Number.isInteger(ttl) || ttl < 60_000) {
      toast.error(t("settings.env.toast.invalidSessionTtl"));
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
      toast.success(t("settings.env.toast.saved"));
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.saveFailed"));
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
            <Toggle checked={allowPrivate} onChange={setAllowPrivate} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label">{t("settings.env.logPayloadMaxChars")}</label>
              <input
                className="input font-mono text-xs"
                inputMode="numeric"
                value={logPayloadMaxChars}
                onChange={(e) => setLogPayloadMaxChars(e.target.value)}
              />
            </div>
            <div>
              <label className="label">{t("settings.env.simulatedStreamingTokenRate")}</label>
              <input
                className="input font-mono text-xs"
                inputMode="numeric"
                value={tokenRate}
                onChange={(e) => setTokenRate(e.target.value)}
              />
            </div>
            <div>
              <label className="label">{t("settings.env.sessionTtlMs")}</label>
              <input
                className="input font-mono text-xs"
                inputMode="numeric"
                value={sessionTtlMs}
                onChange={(e) => setSessionTtlMs(e.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button className="btn-primary btn-xs" onClick={save} disabled={saving}>
              {saving ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-check-lg" />}
              {t("common.save")}
            </button>
          </div>

          <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <i className="bi bi-lock text-ink-500" />
              <span className="text-xs font-medium text-ink-300">{t("settings.env.bootOnly")}</span>
            </div>
            <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
              <ReadonlyRow label={t("settings.env.nodeEnv")} value={data.env.nodeEnv} />
              <ReadonlyRow label={t("settings.env.port")} value={String(data.env.port)} />
              <ReadonlyRow label={t("settings.env.host")} value={data.env.host} />
              <ReadonlyRow label={t("settings.env.dataDir")} value={data.env.dataDir} />
              <ReadonlyRow label={t("settings.env.adminUsername")} value={data.env.adminUsername} />
              <ReadonlyRow label={t("settings.env.cookieSecure")} value={data.env.cookieSecure} />
            </div>
            <p className="mt-2 text-[11px] text-ink-600">{t("settings.env.bootOnly.hint")}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** One read-only env value. The data directory can be an arbitrarily long path,
 * so the value truncates rather than pushing the row wider than its column —
 * `title` keeps the whole thing reachable, and selecting the row still copies it
 * in full. */
function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-ink-500">{label}</span>
      <code className="min-w-0 truncate font-mono text-ink-300" title={value}>
        {value}
      </code>
    </div>
  );
}
