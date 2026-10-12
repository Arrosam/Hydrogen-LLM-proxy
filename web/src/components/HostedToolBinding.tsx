import type { HostedTool, HostedToolOptions } from "../types";
import { setMember } from "../lib/collections";
import { useI18n } from "../lib/i18n";
import { TOOLS_PATH } from "../lib/routes";
import { DEFAULT_HOSTED_TOOL_OPTIONS, HOSTED_TOOL_LIMITS } from "../lib/serviceDef";
import { Field } from "./Field";
import { Select } from "./inputs";
import { BoundedIntInput } from "./numeric";

type StreamMode = HostedToolOptions["streamMode"];

export function HostedToolBinding({ tools, ids, config, onIds, onConfig }: { tools: HostedTool[]; ids: number[]; config: HostedToolOptions; onIds: (ids: number[]) => void; onConfig: (config: HostedToolOptions) => void }) {
  const { t } = useI18n();
  const streamModes: { value: StreamMode; label: string }[] = [
    { value: "all", label: t("hostedTools.stream.all") },
    { value: "progress", label: t("hostedTools.stream.progress") },
    { value: "final", label: t("hostedTools.stream.final") },
  ];
  return (
    <fieldset className="space-y-3 rounded-lg border border-ink-700 p-4">
      <legend className="px-2 text-sm font-semibold">{t("hostedTools.title")}</legend>
      <p className="text-xs text-ink-400">{t("hostedTools.hint")}</p>
      {tools.length ? (
        <div className="flex flex-wrap gap-3">
          {tools.map((tool) => (
            <label key={tool.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ids.includes(tool.id)} onChange={(e) => onIds(setMember(ids, tool.id, e.target.checked))} />
              {tool.name}
              {!tool.enabled && <span className="text-ink-500">({t("hostedTools.disabled")})</span>}
            </label>
          ))}
        </div>
      ) : (
        <a className="text-sm text-brand-400" href={TOOLS_PATH}>{t("hostedTools.register")}</a>
      )}
      <Field as="label" className="block" label={t("hostedTools.stream")}>
        <Select value={config.streamMode} onChange={(streamMode) => onConfig({ ...config, streamMode })} options={streamModes} />
      </Field>
      <p className="text-xs text-ink-500">{t("hostedTools.stream.hint")}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field as="label" label={t("hostedTools.maxRounds")}>
          <BoundedIntInput value={config.maxRounds} onChange={(maxRounds) => onConfig({ ...config, maxRounds })} limits={HOSTED_TOOL_LIMITS.rounds} fallback={DEFAULT_HOSTED_TOOL_OPTIONS.maxRounds} />
        </Field>
        <Field as="label" label={t("hostedTools.maxCalls")}>
          <BoundedIntInput value={config.maxCalls} onChange={(maxCalls) => onConfig({ ...config, maxCalls })} limits={HOSTED_TOOL_LIMITS.calls} fallback={DEFAULT_HOSTED_TOOL_OPTIONS.maxCalls} />
        </Field>
      </div>
    </fieldset>
  );
}
