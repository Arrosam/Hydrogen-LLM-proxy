import { useId, useMemo, useState } from "react";
import { useI18n } from "../lib/i18n";
import type { ServerToolPolicy } from "../types";

/** Suggestions are vocabulary, not discovery or a promise of provider support. */
export const KNOWN_SERVER_TOOL_NAMES = [
  "web_search", "web_fetch", "file_search", "code_interpreter", "computer",
  "image_generation", "mcp", "bash", "text_editor",
];
const PLAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate only the policy boundary when raw JSON enters the visual editor. */
export function isServerToolPolicy(value: unknown): value is ServerToolPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return (policy.mode === "blacklist" || policy.mode === "whitelist")
    && Array.isArray(policy.names) && policy.names.length <= 200
    && policy.names.every(name => typeof name === "string" && PLAIN_NAME.test(name))
    && Object.keys(policy).every(key => key === "mode" || key === "names");
}

export function ServerToolPolicyEditor({ value, onChange, title, knownNames = [], inherited }: {
  value?: ServerToolPolicy;
  onChange: (policy: ServerToolPolicy | undefined) => void;
  title: string;
  knownNames?: string[];
  /** Present only for an upstream step, whose missing policy inherits this value. */
  inherited?: ServerToolPolicy;
}) {
  const { t } = useI18n();
  const id = useId();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const allowInherit = inherited !== undefined;
  const policy = value ?? { mode: "blacklist", names: [] };
  const inheriting = allowInherit && value === undefined;
  const suggestions = useMemo(() => [...new Set([...KNOWN_SERVER_TOOL_NAMES, ...knownNames])]
    .filter(name => !policy.names.includes(name) && name.toLowerCase().includes(query.toLowerCase()))
    .sort(), [knownNames, policy.names, query]);

  const add = (name: string) => {
    if (!PLAIN_NAME.test(name)) { setError(t("serverToolPolicy.invalidName")); return; }
    if (policy.names.length >= 200) { setError(t("serverToolPolicy.tooManyNames")); return; }
    if (!policy.names.includes(name)) onChange({ ...policy, names: [...policy.names, name] });
    setQuery("");
    setError("");
  };

  return <fieldset className="space-y-3 rounded-lg border border-ink-700 p-4">
    <legend className="px-2 text-sm font-semibold text-ink-200">{title}</legend>
    <label className="block" htmlFor={`${id}-mode`}>
      <span className="label">{t("serverToolPolicy.mode")}</span>
      <select id={`${id}-mode`} className="select sm:w-auto" value={inheriting ? "inherit" : policy.mode}
        onChange={event => {
          const mode = event.target.value;
          onChange(mode === "inherit" ? undefined : { mode: mode as ServerToolPolicy["mode"], names: value?.names ?? [] });
          setError("");
        }}>
        {allowInherit && <option value="inherit">{t("serverToolPolicy.inherit")}</option>}
        <option value="blacklist">{t("serverToolPolicy.blacklist")}</option>
        <option value="whitelist">{t("serverToolPolicy.whitelist")}</option>
      </select>
    </label>
    {inheriting ? <p className="text-xs text-ink-400">
      {t("serverToolPolicy.inheritedSummary", { mode: inherited.mode, names: inherited.names.join(", ") || t("serverToolPolicy.emptyList") })}
    </p> : <>
      <p className="text-xs text-ink-400">{t(policy.mode === "blacklist" ? "serverToolPolicy.blacklistHint" : "serverToolPolicy.whitelistHint")}</p>
      {allowInherit && <p className="text-xs text-ink-500">{t("serverToolPolicy.replacesService")}</p>}
      {policy.names.length > 0 ? <ul className="flex flex-wrap gap-2" aria-label={t("serverToolPolicy.names")}>
        {policy.names.map(name => <li key={name} className="flex items-center gap-1 rounded-md border border-ink-600 bg-ink-800 px-2 py-1 text-xs">
          <code>{name}</code><button type="button" className="ml-1 text-ink-400 hover:text-ink-100" aria-label={t("serverToolPolicy.remove", { name })}
            onClick={() => onChange({ ...policy, names: policy.names.filter(item => item !== name) })}>
            <i className="bi bi-x-lg" aria-hidden="true" />
          </button>
        </li>)}
      </ul> : <p className="text-xs text-ink-500">{t("serverToolPolicy.noNames")}</p>}
      <div>
        <label className="label" htmlFor={`${id}-name`}>{t("serverToolPolicy.search")}</label>
        <div className="flex gap-2">
          <input id={`${id}-name`} className="input min-w-0 flex-1 font-mono text-xs" type="search" maxLength={64}
            value={query} aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
            placeholder="web_search" onChange={event => { setQuery(event.target.value); setError(""); }}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(query); } }} />
          <button type="button" className="btn-ghost btn-xs shrink-0" disabled={!query} onClick={() => add(query)}>{t("serverToolPolicy.add")}</button>
        </div>
        <p id={`${id}-hint`} className="mt-1 text-xs text-ink-500">{t("serverToolPolicy.exactHint")}</p>
        {error && <p id={`${id}-error`} className="mt-1 text-xs text-red-400" role="alert">{error}</p>}
      </div>
      <div>
        <p className="mb-2 text-xs text-ink-400">{t("serverToolPolicy.knownNames")}</p>
        <div className="flex flex-wrap gap-2">
          {suggestions.map(name => <button type="button" key={name} className="btn-ghost btn-xs font-mono" aria-label={t("serverToolPolicy.addKnown", { name })} onClick={() => add(name)}>{name}</button>)}
          {suggestions.length === 0 && <span className="text-xs text-ink-500">{t("serverToolPolicy.noMatches")}</span>}
        </div>
      </div>
    </>}
  </fieldset>;
}
