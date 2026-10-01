import type { ThinkingParser } from "../types";
import { useI18n } from "../lib/i18n";

/** Decoding is configured beside the upstream, never beside client presentation. */
export function ThinkingParserEditor({ value, onChange }: {
  value?: ThinkingParser;
  onChange: (value: ThinkingParser) => void;
}) {
  const { t } = useI18n();
  const mode = value?.mode ?? "off";
  const policy = value && value.mode !== "off" ? value.unterminated ?? "error" : "error";
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-ink-700 p-3">
      <label className="label">{t("serviceEditor.thinkingParser")}</label>
      <select className="select" value={mode} onChange={e => {
        const mode = e.target.value as ThinkingParser["mode"];
        onChange(mode === "off" ? { mode } : mode === "custom"
          ? { mode, delimiters: { open: "", close: "" }, unterminated: policy }
          : { mode, unterminated: policy });
      }}>
        {(["off", "think_tags", "custom"] as const).map(mode => <option key={mode} value={mode}>{t(`serviceEditor.thinkingParser.${mode}`)}</option>)}
      </select>
      {value?.mode === "custom" && <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{t("serviceEditor.thinkingOpen")}</label>
          <input className="input" value={value.delimiters.open} maxLength={64}
            onChange={e => onChange({ ...value, delimiters: { ...value.delimiters, open: e.target.value } })}
            placeholder={t("serviceEditor.thinkingOpenPlaceholder")} />
        </div>
        <div>
          <label className="label">{t("serviceEditor.thinkingClose")}</label>
          <input className="input" value={value.delimiters.close} maxLength={64}
            onChange={e => onChange({ ...value, delimiters: { ...value.delimiters, close: e.target.value } })}
            placeholder={t("serviceEditor.thinkingClosePlaceholder")} />
        </div>
      </div>}
      {value && value.mode !== "off" && <>
        <label className="label">{t("serviceEditor.thinkingUnterminated")}</label>
        <select className="select" value={policy} onChange={e => onChange({ ...value, unterminated: e.target.value as "error" | "reasoning" })}>
          <option value="error">{t("serviceEditor.thinkingUnterminated.error")}</option>
          <option value="reasoning">{t("serviceEditor.thinkingUnterminated.reasoning")}</option>
        </select>
        <p className="text-xs text-ink-500">{t("serviceEditor.thinkingDelimitersHint")}</p>
      </>}
    </div>
  );
}
