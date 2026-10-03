import { useEffect, useId, useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import { ErrorNote, Spinner } from "./common";
import { useToast } from "./Toast";

interface PrefixSetting { prefix: string }

export function ServerToolPrefixCard() {
  const { t } = useI18n();
  const toast = useToast();
  const id = useId();
  const { data, loading, error, reload } = useAsync(() => api.get<PrefixSetting>("/settings/server-tool-name-prefix"));
  const [prefix, setPrefix] = useState("");
  const [savedPrefix, setSavedPrefix] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) { setPrefix(data.prefix); setSavedPrefix(data.prefix); }
  }, [data]);

  const save = async () => {
    setSaved(false);
    if (prefix.length > 64 || !/^[A-Za-z0-9_-]*$/.test(prefix)) {
      setSaveError(t("settings.serverToolPrefix.invalid"));
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const result = await api.put<PrefixSetting>("/settings/server-tool-name-prefix", { prefix });
      setPrefix(result.prefix);
      setSavedPrefix(result.prefix);
      setSaved(true);
      toast.success(t("settings.serverToolPrefix.saved"));
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : t("common.saveFailed");
      setSaveError(message);
      toast.error(message);
    } finally { setSaving(false); }
  };

  return <section className="card card-pad mb-5 space-y-3" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="font-medium text-ink-100">{t("settings.serverToolPrefix.title")}</h3>
    <p className="text-xs text-ink-400">{t("settings.serverToolPrefix.hint")}</p>
    {loading && <Spinner />}
    {error && <div className="space-y-2"><ErrorNote message={error} /><button type="button" className="btn-ghost btn-xs" disabled={loading} onClick={reload}>{t("settings.serverToolPrefix.retry")}</button></div>}
    {data && <>
      <label className="block" htmlFor={`${id}-prefix`}><span className="label">{t("settings.serverToolPrefix.label")}</span></label>
      <input id={`${id}-prefix`} className="input font-mono text-xs sm:max-w-md" value={prefix} maxLength={64}
        aria-invalid={saveError ? true : undefined} aria-describedby={`${id}-hint${saveError ? ` ${id}-error` : ""}`}
        disabled={saving || loading} onChange={event => { setPrefix(event.target.value); setSaveError(""); setSaved(false); }} />
      <p id={`${id}-hint`} className="text-xs text-ink-500">{t("settings.serverToolPrefix.emptyHint")}</p>
      {saveError && <p id={`${id}-error`} className="text-sm text-red-400" role="alert">{saveError}</p>}
      {saved && <p className="text-xs text-brand-400" role="status">{t("settings.serverToolPrefix.saved")}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary btn-xs" disabled={saving || loading} onClick={() => void save()}>{t("settings.serverToolPrefix.save")}</button>
        {prefix !== savedPrefix && <button type="button" className="btn-ghost btn-xs" disabled={saving || loading} onClick={() => { setPrefix(savedPrefix); setSaveError(""); setSaved(false); }}>{t("settings.serverToolPrefix.reset")}</button>}
      </div>
    </>}
  </section>;
}
