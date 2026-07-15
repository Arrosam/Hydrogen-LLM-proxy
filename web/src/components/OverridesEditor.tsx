import { useEffect, useMemo, useState } from "react";
import type { Overrides, ThinkingLevel } from "../types";
import { useI18n } from "../lib/i18n";
import { intInput, selectAll } from "../lib/input";

const CUSTOM_SENTINEL = "__custom__";

const THINKING_LEVELS = ["disabled", "auto", "enabled", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_BUDGET_PREFIX = "budget:";

interface Row {
  key: string;
  value: string;
  custom: boolean;
}

const NUMERIC_KEYS = ["temperature", "topP", "topK", "minP", "maxTokens", "frequencyPenalty", "presencePenalty", "repetitionPenalty", "seed", "n", "topLogprobs"] as const;
const BOOL_KEYS = ["logprobs", "parallelToolCalls"] as const;
const STRING_KEYS = ["serviceTier", "user", "system", "verbosity"] as const;
const ARRAY_KEYS = ["stop"] as const;
const ENUM_KEYS: Record<string, string[]> = { verbosity: ["low", "medium", "high"] };

const ALL_KEYS = [
  ...NUMERIC_KEYS,
  ...BOOL_KEYS,
  ...STRING_KEYS,
  ...ARRAY_KEYS,
  "thinking",
  "responseFormat",
  "logitBias",
  "extra",
] as const;

const CANONICAL_SET: ReadonlySet<string> = new Set<string>([
  ...ALL_KEYS, "stream", "system",
]);

function isNumericKey(k: string): boolean {
  return (NUMERIC_KEYS as readonly string[]).includes(k);
}
function isBoolKey(k: string): boolean {
  return (BOOL_KEYS as readonly string[]).includes(k);
}
function isArrayKey(k: string): boolean {
  return (ARRAY_KEYS as readonly string[]).includes(k);
}

function valToString(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function thinkingToValue(tv: ThinkingLevel | undefined): string {
  if (tv == null) return "";
  if (typeof tv === "object") return `${THINKING_BUDGET_PREFIX}${tv.budget}`;
  return tv;
}

function valueToThinking(raw: string): ThinkingLevel | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith(THINKING_BUDGET_PREFIX)) {
    const n = Number(trimmed.slice(THINKING_BUDGET_PREFIX.length));
    return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? { budget: n } : undefined;
  }
  if ((THINKING_LEVELS as readonly string[]).includes(trimmed)) return trimmed as (typeof THINKING_LEVELS)[number];
  return undefined;
}

function coerceValue(key: string, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (key === "thinking") {
    return valueToThinking(trimmed);
  }
  if (isNumericKey(key)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  if (isBoolKey(key)) {
    const lower = trimmed.toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
    return undefined;
  }
  if (isArrayKey(key) || key === "logitBias" || key === "responseFormat" || key === "extra") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (!CANONICAL_SET.has(key)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function rowsToOverrides(rows: Row[]): Overrides | undefined {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    const v = coerceValue(key, r.value);
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length ? (out as Overrides) : undefined;
}

function overridesToRows(ov: Overrides | undefined): Row[] {
  if (!ov) return [];
  const rows: Row[] = [];
  for (const [key, val] of Object.entries(ov)) {
    if (key === "thinking") {
      rows.push({ key, value: thinkingToValue(val as ThinkingLevel), custom: false });
      continue;
    }
    rows.push({ key, value: valToString(val), custom: !CANONICAL_SET.has(key) });
  }
  return rows;
}

interface Props {
  overrides: Overrides | undefined;
  onChange: (ov: Overrides | undefined) => void;
}

export function OverridesEditor({ overrides, onChange }: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"gui" | "json">("gui");
  const [rows, setRows] = useState<Row[]>([]);
  const [jsonText, setJsonText] = useState("");

  const KEY_HINTS: Partial<Record<string, string>> = {
    temperature: t("overrides.hint.temperature"),
    topP: t("overrides.hint.topP"),
    topK: t("overrides.hint.topK"),
    minP: t("overrides.hint.minP"),
    maxTokens: t("overrides.hint.maxTokens"),
    frequencyPenalty: t("overrides.hint.frequencyPenalty"),
    presencePenalty: t("overrides.hint.presencePenalty"),
    repetitionPenalty: t("overrides.hint.repetitionPenalty"),
    seed: t("overrides.hint.seed"),
    n: t("overrides.hint.n"),
    topLogprobs: t("overrides.hint.topLogprobs"),
    stop: t("overrides.hint.stop"),
    logitBias: t("overrides.hint.logitBias"),
    responseFormat: t("overrides.hint.responseFormat"),
    extra: t("overrides.hint.extra"),
    system: t("overrides.hint.system"),
  };

  useEffect(() => {
    setRows(overridesToRows(overrides));
    setJsonText(overrides ? JSON.stringify(overrides, null, 2) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides]);

  const emitJson = (text: string) => {
    setJsonText(text);
    const trimmed = text.trim();
    if (trimmed === "") {
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as Overrides;
      onChange(parsed);
    } catch {
      // keep editing
    }
  };

  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => {
      const next = rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      onChange(rowsToOverrides(next));
      return next;
    });

  const addRow = () => {
    const next = [...rows, { key: "", value: "", custom: false }];
    setRows(next);
  };

  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next);
    onChange(rowsToOverrides(next));
  };

  const onKeySelect = (i: number, selected: string) => {
    if (selected === CUSTOM_SENTINEL) {
      updateRow(i, { key: "", value: "", custom: true });
    } else {
      updateRow(i, { key: selected, value: "", custom: false });
    }
  };

  const usedKeys = useMemo(() => new Set(rows.map((r) => r.key.trim()).filter(Boolean)), [rows]);
  const availableKeys = (ALL_KEYS as readonly string[]).filter((k) => !usedKeys.has(k));

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="label mb-0">
          {t("overrides.title")}
          <span className="ml-2 normal-case text-ink-500">{t("overrides.titleHint")}</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${mode === "gui" ? "bg-brand-600 text-white" : "border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200"}`}
            onClick={() => setMode("gui")}
          >
            <i className="bi bi-sliders mr-1" />
            {t("overrides.fieldsMode")}
          </button>
          <button
            type="button"
            className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${mode === "json" ? "bg-brand-600 text-white" : "border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200"}`}
            onClick={() => setMode("json")}
          >
            <i className="bi bi-code-slash mr-1" />
            {t("overrides.jsonMode")}
          </button>
        </div>
      </div>

      {mode === "gui" ? (
        <div className="space-y-2">
          {rows.length === 0 && (
            <p className="text-xs text-ink-500">{t("overrides.emptyHint")}</p>
          )}

          {rows.map((row, i) => {
            const isCustom = row.custom;
            const thinkingIsBudget = row.key === "thinking" && row.value.startsWith(THINKING_BUDGET_PREFIX);
            const thinkingBudget = thinkingIsBudget ? row.value.slice(THINKING_BUDGET_PREFIX.length) : "";
            const thinkingLevelVal = row.key === "thinking" && !thinkingIsBudget ? row.value : "";

            return (
              <div key={i} className="flex items-start gap-1.5">
                {isCustom ? (
                  <input
                    className="input h-8 w-36 py-0 text-xs font-mono"
                    type="text"
                    placeholder={t("overrides.customKeyPlaceholder")}
                    value={row.key}
                    onChange={(e) => updateRow(i, { key: e.target.value, custom: true })}
                  />
                ) : (
                  <select
                    className="input h-8 w-36 py-0 text-xs"
                    value={row.key === "" ? "" : row.key}
                    onChange={(e) => onKeySelect(i, e.target.value)}
                  >
                    {row.key === "" && <option value="">{t("overrides.pickField")}</option>}
                    {row.key !== "" && !availableKeys.includes(row.key) && (
                      <option value={row.key}>{row.key}</option>
                    )}
                    {availableKeys.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                    <option value={CUSTOM_SENTINEL}>— {t("overrides.customOption")} —</option>
                  </select>
                )}

                {row.key === "thinking" ? (
                  <div className="flex flex-1 items-center gap-1.5">
                    <select
                      className="input h-8 flex-1 py-0 text-xs"
                      value={thinkingIsBudget ? "budget" : thinkingLevelVal}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "") updateRow(i, { value: "" });
                        else if (v === "budget") updateRow(i, { value: `${THINKING_BUDGET_PREFIX}8192` });
                        else updateRow(i, { value: v });
                      }}
                    >
                      <option value="">{t("overrides.inherit")}</option>
                      {THINKING_LEVELS.map((l) => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                      <option value="budget">{t("thinking.budgetTokens")}</option>
                    </select>
                    {thinkingIsBudget && (
                      <input
                        className="input h-8 w-28 py-0 text-xs"
                        type="text"
                        inputMode="numeric"
                        value={thinkingBudget}
                        onFocus={selectAll}
                        onClick={selectAll}
                        onChange={(e) => updateRow(i, { value: `${THINKING_BUDGET_PREFIX}${intInput(e.target.value, 8192, 1024)}` })}
                        placeholder={t("thinking.tokenBudgetPlaceholder")}
                      />
                    )}
                  </div>
                ) : ENUM_KEYS[row.key] ? (
                  <select
                    className="input h-8 flex-1 py-0 text-xs"
                    value={row.value}
                    onChange={(e) => updateRow(i, { value: e.target.value })}
                  >
                    <option value="">{t("overrides.inherit")}</option>
                    {ENUM_KEYS[row.key].map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input h-8 flex-1 py-0 font-mono text-xs"
                    type="text"
                    value={row.value}
                    onChange={(e) => updateRow(i, { value: e.target.value })}
                    onFocus={selectAll}
                    placeholder={KEY_HINTS[row.key] ?? (isCustom ? t("overrides.jsonOrTextPlaceholder") : t("overrides.valuePlaceholder"))}
                  />
                )}
                <button
                  type="button"
                  className="btn-danger btn-xs shrink-0"
                  onClick={() => removeRow(i)}
                  title={t("overrides.removeOverrideTitle")}
                >
                  <i className="bi bi-x-lg" />
                </button>
              </div>
            );
          })}

          <button type="button" className="btn-ghost btn-xs" onClick={addRow}>
            <i className="bi bi-plus-lg mr-1" />
            {t("overrides.addField")}
          </button>
        </div>
      ) : (
        <div>
          <textarea
            className="input min-h-[160px] font-mono text-xs"
            value={jsonText}
            onChange={(e) => emitJson(e.target.value)}
            placeholder='{"topP": 0.9, "topK": 40, "maxTokens": 4096, "thinking": "high"}'
          />
          <p className="mt-1 text-[11px] text-ink-600">
            {t("overrides.jsonHint")}
          </p>
        </div>
      )}
    </div>
  );
}
