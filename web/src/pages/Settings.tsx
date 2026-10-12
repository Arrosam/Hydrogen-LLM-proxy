import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { useFields } from "../lib/crud";
import { apiErrorMessage } from "../lib/errors";
import { useAction, useAsync, useAttempt } from "../lib/hooks";
import { useI18n, type Language } from "../lib/i18n";
import { Button, buttonClass, Icon, type ButtonProps } from "../components/Button";
import { RemovableChip, SegmentedControl } from "../components/Chip";
import { ErrorNote, Toggle, useConfirm } from "../components/common";
import { Field } from "../components/Field";
import { TextInput } from "../components/inputs";
import { HydrogenLogo } from "../components/Logo";
import { AsyncStatus, PageHeader } from "../components/Page";
import { SectionCard } from "../components/Section";
import { NumericSettingCard } from "../components/SettingCard";
import { useToast } from "../components/Toast";
import { HOURS_PER_DAY, MIB, MINUTES_PER_HOUR } from "../lib/constants";
import { downloadFile } from "../lib/download";
import { API } from "../lib/endpoints";
import { formatNumber } from "../lib/format";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { newPasswordProblem } from "../lib/password";
import { HOME_PATH } from "../lib/routes";
import { pollUntil } from "../lib/usePolling";

/** The UI languages, in the order the picker offers them. */
const LANGUAGES: readonly Language[] = ["en", "zh"];

/** Longest retention either retention card accepts, in days. */
const MAX_RETENTION_DAYS = 3650;
/** Shown in the response-retention field until the stored value has loaded. */
const DEFAULT_RESPONSE_RETENTION_DAYS = 30;

/** After asking for a restart: how long the old process gets to shut down... */
const RESTART_GRACE_MS = 3000;
/** ...how long to keep waiting for the new one to answer... */
const RESTART_DEADLINE_MS = 120_000;
/** ...and how often to ask while it does not. */
const RESTART_POLL_MS = 2500;
/** Shown for a release whose version the check could not name. */
const UNKNOWN_VERSION = "?";
/** How a Compose deployment is updated by hand: a pulled image, or a source build. */
const DOCKER_UPDATE_COMMANDS = [
  { label: "settings.update.manual.docker.image", command: "docker compose pull && docker compose up -d" },
  { label: "settings.update.manual.docker.source", command: "git pull && docker compose up -d --build" },
] as const;

/** Pause between a restore's success toast and the reload onto the login screen. */
const RESTORE_RELOAD_DELAY_MS = 1200;
const BACKUP_FILE_PREFIX = "hydrogen-backup-";
/** Digits of the month and day in a backup's file name. */
const DATE_PART_WIDTH = 2;
const MIN_PASSPHRASE = 8;
/** The export's two switches, with the space above each. Their captions are
 * `settings.backup.<key>` and `settings.backup.<key>.hint`. */
const EXPORT_SWITCHES = [
  { key: "includeLogs", gap: "mt-3" },
  { key: "includeImageCache", gap: "mt-2" },
] as const;

/** Largest image cache the size field accepts, in MiB. */
const MAX_IMAGE_CACHE_MIB = 65536;
const IMAGE_CACHE_PLACEHOLDER_MIB = "64";
/** A fractional MiB value shows two decimals below this size and one from it up. */
const MIB_FINE_BELOW = 10;
const MIB_DECIMALS = { fine: 2, coarse: 1 } as const;

/** Bounds the environment card checks before saving. */
const ENV_LIMITS = {
  maxLogPayloadChars: 10_000_000,
  minTokenRate: 1,
  minSessionTtlMs: 60_000,
  minPromptCacheTtlMinutes: 1,
  /** One day (mirrors MAX_PROMPT_CACHE_TTL_MINUTES in the server's settings routes). */
  maxPromptCacheTtlMinutes: HOURS_PER_DAY * MINUTES_PER_HOUR,
} as const;
/** The environment card's number boxes, in grid order; each is captioned `settings.env.<key>`. */
const ENV_NUMBER_FIELDS = ["logPayloadMaxChars", "simulatedStreamingTokenRate", "promptCacheTtlMinutes", "sessionTtlMs"] as const;
/** The boot-time values it lists read-only, likewise captioned `settings.env.<key>`. */
const ENV_BOOT_FIELDS = ["nodeEnv", "port", "host", "dataDir", "adminUsername", "cookieSecure"] as const;

/** Save as the retention and image-cache cards draw it: small, ghost, with a check that spins while saving. */
const COMPACT_SAVE: Pick<ButtonProps, "variant" | "size" | "icon" | "className" | "spinWhenBusy"> = {
  variant: "ghost",
  size: "xs",
  icon: ACTION_ICON.save,
  className: "whitespace-nowrap",
  spinWhenBusy: true,
};

interface EnvSettings {
  allowPrivateUpstreams: boolean;
  logPayloadMaxChars: number;
  simulatedStreamingTokenRate: number;
  sessionTtlMs: number;
  promptCacheTtlMinutes: number;
  env: {
    nodeEnv: string;
    port: number;
    host: string;
    dataDir: string;
    adminUsername: string;
    cookieSecure: string;
  };
}

/** `raw` as a number inside [min, max] (a whole one unless `integer` is off), or null. */
function parseBounded(raw: string, { min = 0, max = Infinity, integer = true }: { min?: number; max?: number; integer?: boolean }): number | null {
  const n = Number(raw.trim());
  const wellFormed = integer ? Number.isInteger(n) : Number.isFinite(n);
  return wellFormed && n >= min && n <= max ? n : null;
}

/** Admin-only: the route and every settings endpoint are gated to admins, so
 * this page never has to render a read-only variant of itself. */
export function Settings() {
  const { t } = useI18n();

  return (
    <div>
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} icon={ENTITY_ICON.settings} />
      <UpdateCard />
      <LanguageCard />
      <BackupCard />
      <RetentionCard />
      <ResponseRetentionCard />
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
  const { data } = useAsync(() => api.get<{ version: string }>(API.settingsVersion));
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
  /** Whether the offered release is a pre-release. Only a deployment already
   * running one is ever offered one, but the badge still says so. */
  prerelease: boolean;
  checkedAt: number;
  runtime: "kubernetes" | "docker" | "node";
  restartSupported: boolean;
  error?: string;
}

/** An icon and a short line of status text beside the version. */
function StatusLine({ icon, tone, children }: { icon: string; tone: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${tone}`}>
      <Icon name={icon} />
      {children}
    </span>
  );
}

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
  const [restarting, setRestarting] = useState(false);
  const [restartMismatch, setRestartMismatch] = useState(false);
  const checking = useAction({ onError: setCheckError });
  const attempt = useAttempt();

  const check = (refresh: boolean) =>
    checking.run(async () => {
      const s = await api.get<UpdateStatus>(refresh ? API.updateCheckRefresh : API.updateCheck);
      setStatus(s);
      setCheckError(s.error ?? null);
      if (!s.updateAvailable) setRestartMismatch(false);
    }, t("settings.update.toast.checkFailed"));

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
    const accepted = await attempt(async () => {
      await api.post(API.updateRestart);
    }, t("common.saveFailed"));
    if (!accepted) {
      setRestarting(false);
      return;
    }

    // Wait out the shutdown, then poll until the server answers again.
    const back = await pollUntil(() => api.get<UpdateStatus>(API.updateCheck), {
      graceMs: RESTART_GRACE_MS,
      intervalMs: RESTART_POLL_MS,
      deadlineMs: RESTART_DEADLINE_MS,
    });
    setRestarting(false);
    if (!back) {
      setRestartMismatch(true);
      toast.error(t("settings.update.toast.timeout"));
      return;
    }
    const s = back.value;
    setStatus(s);
    if (s.current === target) {
      toast.success(t("settings.update.toast.upgraded", { version: s.current }));
      return;
    }
    setRestartMismatch(true);
    toast.error(
      s.current === before
        ? t("settings.update.toast.sameVersion", { version: s.current })
        : t("settings.update.toast.unexpectedVersion", { actual: s.current, expected: target }),
    );
  };

  const publishedDate = status?.publishedAt ? new Date(status.publishedAt).toLocaleDateString() : null;
  const latest = status?.latest ?? UNKNOWN_VERSION;

  return (
    <SectionCard icon="bi-cloud-arrow-down" title={t("settings.update")} hint={t("settings.update.hint")}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-ink-500">{t("settings.update.current")}</span>
        <code className="rounded-md border border-ink-700 bg-ink-900 px-2 py-0.5 font-mono text-xs text-ink-200">
          {status ? `v${status.current}` : "…"}
        </code>
        {status && !status.error && !restarting && (
          status.updateAvailable ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
              <Icon name="bi-arrow-up-circle" />
              {t("settings.update.available", { version: latest })}
              {status.prerelease && (
                <span className="rounded border border-amber-500/40 px-1 text-amber-400/90">
                  {t("settings.update.prerelease")}
                </span>
              )}
              {publishedDate && <span className="text-amber-400/70">· {t("settings.update.publishedAt", { date: publishedDate })}</span>}
            </span>
          ) : (
            <StatusLine icon="bi-check-circle" tone="text-emerald-400">
              {t("settings.update.upToDate")}
            </StatusLine>
          )
        )}
        {restarting && (
          <StatusLine icon={ACTION_ICON.busy} tone="text-ink-300">
            {t("settings.update.restarting")}
          </StatusLine>
        )}
      </div>

      {checkError && <p className="mt-2 text-xs text-red-400">{checkError}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="xs" icon={ACTION_ICON.refresh} busy={checking.busy} spinWhenBusy disabled={restarting} onClick={() => void check(true)}>
          {t("settings.update.checkNow")}
        </Button>
        {status?.updateAvailable && status.releaseUrl && (
          <a className={buttonClass("ghost", "xs")} href={status.releaseUrl} target="_blank" rel="noreferrer">
            <Icon name={ACTION_ICON.external} />
            {t("settings.update.releaseNotes")}
          </a>
        )}
        {status?.updateAvailable && status.restartSupported && (
          <Button variant="primary" size="xs" icon="bi-cloud-arrow-down" busy={restarting} spinWhenBusy onClick={() => void upgrade()}>
            {t("settings.update.upgradeAction")}
          </Button>
        )}
      </div>

      {status?.updateAvailable && (!status.restartSupported || restartMismatch) && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-ink-300">
          <p className="mb-2">
            {t(status.restartSupported ? "settings.update.manual.mismatch" : "settings.update.manual.disabled")}
          </p>
          {status.runtime === "docker" && (
            <div className="space-y-2">
              {DOCKER_UPDATE_COMMANDS.map((c) => (
                <div key={c.label}>
                  <p className="mb-1 text-ink-500">{t(c.label)}</p>
                  <code className="block rounded bg-ink-950 px-2 py-1 font-mono text-[11px] text-ink-200">{c.command}</code>
                </div>
              ))}
            </div>
          )}
          {(status.runtime === "kubernetes" || status.runtime === "node") && (
            <p>{t(`settings.update.manual.${status.runtime}`, { version: latest })}</p>
          )}
          <p className="mt-2 text-ink-500">{t("settings.update.manual.pinned")}</p>
        </div>
      )}
      {confirmEl}
    </SectionCard>
  );
}

function LanguageCard() {
  const { t, language, setLanguage } = useI18n();
  const saving = useAction();

  const choose = (lang: Language) => {
    if (lang === language) return;
    void saving.run(() => setLanguage(lang));
  };

  return (
    <SectionCard icon="bi-translate" title={t("settings.language")} hint={t("settings.language.hint")}>
      <SegmentedControl
        value={language}
        onChange={choose}
        options={LANGUAGES.map((lang) => ({ value: lang, label: t(`settings.language.${lang}`) }))}
        size="md"
        tone="soft"
        gap="loose"
        disabled={saving.busy}
      />
    </SectionCard>
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

/** `hydrogen-backup-2026-07-17.json` — dated so successive backups don't collide. */
function backupFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(DATE_PART_WIDTH, "0");
  return `${BACKUP_FILE_PREFIX}${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/** A passphrase box of the backup card. */
function PassphraseField({
  label,
  autoComplete,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  autoComplete: string;
  placeholder: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <Field label={label}>
      <TextInput type="password" autoComplete={autoComplete} className="text-xs" value={value} onChange={onChange} placeholder={placeholder} />
    </Field>
  );
}

/** The amber caution under a backup box's fields. */
function BackupWarning({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-400/90">
      <Icon name="bi-exclamation-triangle" className="mt-0.5" />
      <span>{children}</span>
    </p>
  );
}

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

  const form = useFields({
    passphrase: "",
    confirmPassphrase: "",
    includeLogs: true,
    // Off by default, like the server: the descriptions are regenerable, and the
    // cache can be the largest thing in the package.
    includeImageCache: false,
    restorePassphrase: "",
  });
  const { passphrase, confirmPassphrase, includeLogs, includeImageCache, restorePassphrase } = form.values;
  const [file, setFile] = useState<File | null>(null);
  const exporting = useAction();
  const restoring = useAction();

  const runExport = async () => {
    const problem = newPasswordProblem(passphrase, confirmPassphrase, MIN_PASSPHRASE);
    if (problem) {
      toast.error(
        problem === "tooShort"
          ? t("settings.backup.toast.passphraseTooShort", { min: MIN_PASSPHRASE })
          : t("settings.backup.toast.passphraseMismatch"),
      );
      return;
    }
    await exporting.run(async () => {
      const r = await api.post<{ backup: unknown }>(API.backupExport, { passphrase, includeLogs, includeImageCache });
      downloadFile(backupFilename(), JSON.stringify(r.backup));
      toast.success(t("settings.backup.toast.exported"));
      form.patch({ passphrase: "", confirmPassphrase: "" });
    }, t("settings.backup.toast.exportFailed"));
  };

  const runRestore = async () => {
    if (!file) return;
    if (!restorePassphrase) {
      toast.error(t("settings.backup.toast.passphraseRequired"));
      return;
    }
    const ok = await confirm(t("settings.backup.confirm.title"), t("settings.backup.confirm.body", { file: file.name }));
    if (!ok) return;

    await restoring.run(async () => {
      const text = await file.text();
      let backup: unknown;
      try {
        backup = JSON.parse(text);
      } catch {
        toast.error(t("settings.backup.toast.notJson"));
        return;
      }
      const r = await api.post<RestoreReport>(API.backupRestore, { passphrase: restorePassphrase, backup });
      const rows = Object.values(r.restored).reduce((a, b) => a + b, 0);
      toast.success(t("settings.backup.toast.restored", { rows }));
      // The server has ended this session — the users table it authenticated
      // against no longer exists. Reload straight into the login screen.
      setTimeout(() => window.location.assign(HOME_PATH), RESTORE_RELOAD_DELAY_MS);
    }, t("settings.backup.toast.restoreFailed"));
  };

  return (
    <SectionCard icon="bi-archive" title={t("settings.backup")} hint={t("settings.backup.hint")} hintGap="lg">
      <SectionCard variant="box" icon="bi-download" title={t("settings.backup.export")} hint={t("settings.backup.export.hint")}>
        <div className="grid max-w-xl gap-2 sm:grid-cols-2">
          <PassphraseField
            label={t("settings.backup.passphrase")}
            autoComplete="new-password"
            placeholder={t("settings.backup.passphrase.placeholder")}
            {...form.bind("passphrase")}
          />
          <PassphraseField
            label={t("settings.backup.passphraseConfirm")}
            autoComplete="new-password"
            placeholder={t("settings.backup.passphrase.placeholder")}
            {...form.bind("confirmPassphrase")}
          />
        </div>

        <BackupWarning>{t("settings.backup.passphrase.warning")}</BackupWarning>

        {EXPORT_SWITCHES.map(({ key, gap }) => (
          <div key={key} className={`${gap} flex items-center gap-2`}>
            <Toggle checked={form.values[key]} onChange={(on) => form.set(key, on)} />
            <span className="text-xs text-ink-300">{t(`settings.backup.${key}`)}</span>
            <span className="text-xs text-ink-500">{t(`settings.backup.${key}.hint`)}</span>
          </div>
        ))}

        <Button variant="primary" size="xs" className="mt-4" icon="bi-download" busy={exporting.busy} spinWhenBusy onClick={() => void runExport()}>
          {t("settings.backup.exportAction")}
        </Button>
      </SectionCard>

      <SectionCard variant="box" className="mt-4" icon="bi-upload" title={t("settings.backup.restore")} hint={t("settings.backup.restore.hint")}>
        <div className="grid max-w-xl gap-2 sm:grid-cols-2">
          <Field label={t("settings.backup.file")}>
            <TextInput
              type="file"
              accept="application/json,.json"
              className="text-xs file:mr-2 file:rounded file:border-0 file:bg-ink-800 file:px-2 file:py-0.5 file:text-xs file:text-ink-200"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <PassphraseField
            label={t("settings.backup.passphrase")}
            autoComplete="off"
            placeholder={t("settings.backup.passphrase.restorePlaceholder")}
            {...form.bind("restorePassphrase")}
          />
        </div>

        <BackupWarning>{t("settings.backup.restore.warning")}</BackupWarning>

        <Button variant="ghost" size="xs" className="mt-4" icon="bi-upload" busy={restoring.busy} spinWhenBusy disabled={!file} onClick={() => void runRestore()}>
          {t("settings.backup.restoreAction")}
        </Button>
      </SectionCard>
      {confirmEl}
    </SectionCard>
  );
}

function RetentionCard() {
  const { t } = useI18n();
  const state = useAsync(() => api.get<{ days: number }>(API.settingsLogRetention));

  return (
    <NumericSettingCard
      icon="bi-clock-history"
      title={t("settings.logRetention")}
      hint={t("settings.logRetention.hint")}
      state={state}
      // Save waits for the stored value: an empty box means "off", so saving one
      // that is empty only because the load failed would switch pruning off.
      loadDisplay="inlineError"
      toText={(d) => String(d.days)}
      // An empty box means "off", the same as 0.
      parse={(raw) => parseBounded(raw.trim() || "0", { max: MAX_RETENTION_DAYS })}
      invalidMessage={t("settings.logRetention.toast.invalidDays")}
      onSave={async (days) => {
        const r = await api.put<{ days: number; pruned: number }>(API.settingsLogRetention, { days });
        if (days === 0) return t("settings.logRetention.toast.disabled");
        return r.pruned
          ? t("settings.logRetention.toast.savedPruned", { days, pruned: r.pruned })
          : t("settings.logRetention.toast.saved", { days });
      }}
      onSaved={state.reload}
      describeSaveError={(e) => apiErrorMessage(e, t("common.saveFailed"))}
      input={{ mono: true, className: "w-32", inputMode: "numeric", placeholder: "0" }}
      unit={t("common.days")}
      saveLabel={t("common.save")}
      saveButton={COMPACT_SAVE}
    />
  );
}

/**
 * The second retention card, for response and tool-session history. It does
 * the same job as `RetentionCard` in a different dress, each difference kept
 * on purpose until the owner aligns them: a plain section with an h2, a native
 * number box (an emptied box snaps to 0), a full-size primary Save, and no
 * reload after a save. Bounds and failure texts are the same as its sibling's.
 */
function ResponseRetentionCard() {
  const { t } = useI18n();
  const state = useAsync(() => api.get<{ days: number }>(API.settingsResponseRetention));

  return (
    <NumericSettingCard
      frame="flat"
      title={t("settings.responseRetention")}
      hint={t("settings.responseRetention.hint")}
      state={state}
      loadDisplay="inlineError"
      initialText={String(DEFAULT_RESPONSE_RETENTION_DAYS)}
      toText={(d) => String(d.days)}
      normalize={(raw) => String(Number(raw))}
      parse={(raw) => parseBounded(raw, { max: MAX_RETENTION_DAYS })}
      invalidMessage={t("settings.logRetention.toast.invalidDays")}
      onSave={async (days) => {
        await api.put(API.settingsResponseRetention, { days });
        return t("settings.responseRetention.toast.saved");
      }}
      describeSaveError={(e) => apiErrorMessage(e, t("common.saveFailed"))}
      input={{ type: "number", min: 0, max: MAX_RETENTION_DAYS, className: "w-28" }}
      caption={t("settings.responseRetention.days")}
      saveLabel={t("common.save")}
      saveButton={{ variant: "primary" }}
    />
  );
}

/** Bytes as MiB for display: whole numbers stay whole, odd values keep enough
 * precision to be recognisable rather than rounding to "0". */
function toMib(bytes: number): string {
  const mib = bytes / MIB;
  if (Number.isInteger(mib)) return String(mib);
  return mib.toFixed(mib < MIB_FINE_BELOW ? MIB_DECIMALS.fine : MIB_DECIMALS.coarse);
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
  const state = useAsync(() => api.get<ImageCacheState>(API.settingsImageCache));
  const { data, reload } = state;
  const clearing = useAction();

  const clear = async () => {
    const ok = await confirm(t("settings.imageCache.confirm.title"), t("settings.imageCache.confirm.body"));
    if (!ok) return;
    await clearing.run(async () => {
      const r = await api.del<{ cleared: number }>(API.settingsImageCache);
      toast.success(t("settings.imageCache.toast.cleared", { cleared: r.cleared }));
      reload();
    }, t("common.saveFailed"));
  };

  return (
    <NumericSettingCard
      icon="bi-images"
      title={t("settings.imageCache")}
      hint={t("settings.imageCache.hint")}
      state={state}
      loadDisplay="gated"
      toText={(d) => toMib(d.maxBytes)}
      parse={(raw) => parseBounded(raw, { max: MAX_IMAGE_CACHE_MIB, integer: false })}
      invalidMessage={t("settings.imageCache.toast.invalidSize")}
      onSave={async (mib) => {
        const r = await api.put<ImageCacheState & { evicted: number }>(API.settingsImageCache, { maxBytes: Math.round(mib * MIB) });
        if (mib === 0) return t("settings.imageCache.toast.disabled");
        return r.evicted
          ? t("settings.imageCache.toast.savedEvicted", { size: toMib(r.maxBytes), evicted: r.evicted })
          : t("settings.imageCache.toast.saved", { size: toMib(r.maxBytes) });
      }}
      onSaved={reload}
      describeSaveError={(e) => apiErrorMessage(e, t("common.saveFailed"))}
      input={{ mono: true, className: "w-32", inputMode: "decimal", placeholder: IMAGE_CACHE_PLACEHOLDER_MIB }}
      unit={t("settings.imageCache.unit")}
      wrap
      saveLabel={t("common.save")}
      saveButton={COMPACT_SAVE}
      extraActions={
        <Button
          variant="ghost"
          size="xs"
          className="whitespace-nowrap"
          icon={ACTION_ICON.removeAlt}
          busy={clearing.busy}
          spinWhenBusy
          disabled={data?.entries === 0}
          onClick={() => void clear()}
        >
          {t("settings.imageCache.clear")}
        </Button>
      }
      footer={
        data && (
          <p className="mt-2 text-xs text-ink-500">
            {data.maxBytes === 0
              ? t("settings.imageCache.off")
              : t("settings.imageCache.usage", {
                  used: toMib(data.usedBytes),
                  max: toMib(data.maxBytes),
                  entries: formatNumber(data.entries),
                })}
          </p>
        )
      }
    >
      {confirmEl}
    </NumericSettingCard>
  );
}

function AllowlistCard() {
  const { t } = useI18n();
  const toast = useToast();
  const { data, error, reload } = useAsync(() => api.get<{ entries: string[] }>(API.settingsUpstreamAllowlist));
  const [entry, setEntry] = useState("");
  const saving = useAction();
  const entries = data?.entries ?? [];

  const put = (next: string[]) =>
    saving.run(async () => {
      await api.put(API.settingsUpstreamAllowlist, { entries: next });
      reload();
      toast.success(t("settings.allowlist.toast.updated"));
    }, t("common.saveFailed"));

  const add = () => {
    // The PUT replaces the whole list: without the stored one there is nothing to append to.
    if (!data) return;
    const v = entry.trim();
    if (!v || entries.includes(v)) {
      setEntry("");
      return;
    }
    // A refused entry stays in the box to be corrected.
    void put([...entries, v]).then((saved) => {
      if (saved) setEntry("");
    });
  };

  return (
    <SectionCard icon="bi-shield-lock" title={t("settings.allowlist")} hint={t("settings.allowlist.hint")}>
      <div className="mb-3 flex flex-wrap gap-2">
        {!error && entries.length === 0 && <span className="text-xs text-ink-600">{t("settings.allowlist.empty")}</span>}
        {entries.map((e) => (
          <RemovableChip
            key={e}
            mono
            removeTone="muted"
            removeTitle={t("common.remove")}
            disabled={saving.busy}
            onRemove={() => void put(entries.filter((x) => x !== e))}
          >
            {e}
          </RemovableChip>
        ))}
      </div>
      <div className="flex gap-2">
        <TextInput
          mono
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={t("settings.allowlist.placeholder")}
        />
        <Button variant="ghost" size="xs" className="whitespace-nowrap" icon={ACTION_ICON.add} busy={saving.busy} disabled={!data} onClick={add}>
          {t("common.add")}
        </Button>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      )}
    </SectionCard>
  );
}

function EnvCard() {
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync(() => api.get<EnvSettings>(API.settingsEnv));
  const { data, reload } = state;
  const form = useFields({
    allowPrivateUpstreams: false,
    logPayloadMaxChars: "",
    simulatedStreamingTokenRate: "",
    sessionTtlMs: "",
    promptCacheTtlMinutes: "",
  });
  const saving = useAction();

  useEffect(() => {
    if (!data) return;
    form.patch({
      allowPrivateUpstreams: data.allowPrivateUpstreams,
      logPayloadMaxChars: String(data.logPayloadMaxChars),
      simulatedStreamingTokenRate: String(data.simulatedStreamingTokenRate),
      sessionTtlMs: String(data.sessionTtlMs),
      promptCacheTtlMinutes: String(data.promptCacheTtlMinutes),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const save = async () => {
    const v = form.values;
    const logPayloadMaxChars = parseBounded(v.logPayloadMaxChars, { max: ENV_LIMITS.maxLogPayloadChars });
    const simulatedStreamingTokenRate = parseBounded(v.simulatedStreamingTokenRate, { min: ENV_LIMITS.minTokenRate });
    const sessionTtlMs = parseBounded(v.sessionTtlMs, { min: ENV_LIMITS.minSessionTtlMs });
    const cacheTtlLimits = { min: ENV_LIMITS.minPromptCacheTtlMinutes, max: ENV_LIMITS.maxPromptCacheTtlMinutes };
    // An emptied box is not a number here (parseBounded alone would read it as 0).
    const promptCacheTtlMinutes = v.promptCacheTtlMinutes.trim() ? parseBounded(v.promptCacheTtlMinutes, cacheTtlLimits) : null;
    // Only the first invalid field is reported, in this order.
    if (logPayloadMaxChars === null || simulatedStreamingTokenRate === null || sessionTtlMs === null || promptCacheTtlMinutes === null) {
      toast.error(
        logPayloadMaxChars === null
          ? t("settings.env.toast.invalidLogPayloadMaxChars")
          : simulatedStreamingTokenRate === null
            ? t("settings.env.toast.invalidTokenRate")
            : sessionTtlMs === null
              ? t("settings.env.toast.invalidSessionTtl")
              : t("settings.env.toast.invalidPromptCacheTtl", cacheTtlLimits),
      );
      return;
    }
    await saving.run(async () => {
      await api.put<EnvSettings>(API.settingsEnv, {
        allowPrivateUpstreams: v.allowPrivateUpstreams,
        logPayloadMaxChars,
        simulatedStreamingTokenRate,
        sessionTtlMs,
        promptCacheTtlMinutes,
      });
      toast.success(t("settings.env.toast.saved"));
      reload();
    }, t("common.saveFailed"));
  };

  return (
    <SectionCard icon="bi-sliders" title={t("settings.env")} hint={t("settings.env.hint")} hintGap="lg">
      <AsyncStatus state={state} />
      {data && (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <label className="label">{t("settings.env.allowPrivate")}</label>
              <p className="text-xs text-ink-500">{t("settings.env.allowPrivate.hint")}</p>
            </div>
            <Toggle checked={form.values.allowPrivateUpstreams} onChange={(on) => form.set("allowPrivateUpstreams", on)} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {ENV_NUMBER_FIELDS.map((key) => (
              <Field key={key} label={t(`settings.env.${key}`)}>
                <TextInput mono inputMode="numeric" {...form.bind(key)} />
              </Field>
            ))}
          </div>

          <div className="flex justify-end">
            <Button variant="primary" size="xs" icon={ACTION_ICON.save} busy={saving.busy} spinWhenBusy onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>

          <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Icon name="bi-lock" className="text-ink-500" />
              <span className="text-xs font-medium text-ink-300">{t("settings.env.bootOnly")}</span>
            </div>
            <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
              {ENV_BOOT_FIELDS.map((key) => (
                <ReadonlyRow key={key} label={t(`settings.env.${key}`)} value={String(data.env[key])} />
              ))}
            </div>
            <p className="mt-2 text-[11px] text-ink-600">{t("settings.env.bootOnly.hint")}</p>
          </div>
        </div>
      )}
    </SectionCard>
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
