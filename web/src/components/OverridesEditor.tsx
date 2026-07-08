import { useEffect, useMemo, useState } from "react";
import type { Overrides, ThinkingLevel } from "../types";
import { ThinkingLevelInput } from "./ThinkingLevelInput";
import { selectAll } from "../lib/input";

/**
 * A single attribute/value row in the graphical overrides editor.
 * Each row maps to one key in the Overrides object.
 */
interface Row {
  key: string;
  value: string;
}

/**
 * The canonical keys the Overrides object supports (mirrors server
 * OverridesSchema). Values are stored as strings in the UI and coerced
 * to the right type when building the Overrides object.
 */
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

const KEY_HINTS: Partial<Record<string, string>> = {
  temperature: "0–2",
  topP: "0–1",
  topK: "≥0 integer",
  minP: "0–1",
  maxTokens: "≥1 integer",
  frequencyPenalty: "-2 to 2",
  presencePenalty: "-2 to 2",
  repetitionPenalty: "0–2",
  seed: "integer",
  n: "1–128 integer",
  topLogprobs: "0–20 integer",
  stop: '["stop1","stop2"]',
  logitBias: '{"token_id": bias}',
  responseFormat: '{"type":"json_object"}',
  extra: '{"vendor_key": value}',
  system: "system prompt text",
};

function isNumericKey(k: string): boolean {
  return (NUMERIC_KEYS as readonly string[]).includes(k);
}
function isBoolKey(k: string): boolean {
  return (BOOL_KEYS as readonly string[]).includes(k);
}
function isArrayKey(k: string): boolean {
  return (ARRAY_KEYS as readonly string[]).includes(k);
}

/** Convert an Overrides field value to its string representation for the UI. */
function valToString(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

/** Coerce a string value to the proper type for the Overrides object. */
function coerceValue(key: string, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
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
      return undefined; // invalid JSON — skip
    }
  }
  if (key === "thinking") {
    // thinking is handled by the ThinkingLevelInput, not a text field
    return undefined;
  }
  return trimmed;
}

/** Build an Overrides object from the graphical rows + thinking. */
function rowsToOverrides(rows: Row[], thinking: ThinkingLevel | undefined): Overrides | undefined {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    if (key === "thinking") {
      if (thinking != null) out.thinking = thinking;
      continue;
    }
    const v = coerceValue(key, r.value);
    if (v !== undefined) out[key] = v;
  }
  if (thinking != null) out.thinking = thinking;
  return Object.keys(out).length ? (out as Overrides) : undefined;
}

/** Decompose an existing Overrides object into rows for the graphical editor. */
function overridesToRows(ov: Overrides | undefined): Row[] {
  if (!ov) return [];
  const rows: Row[] = [];
  for (const [key, val] of Object.entries(ov)) {
    if (key === "thinking") continue; // thinking has its own input
    rows.push({ key, value: valToString(val) });
  }
  return rows;
}

interface Props {
  overrides: Overrides | undefined;
  onChange: (ov: Overrides | undefined) => void;
  /** Whether to show the thinking-level input (default true). */
  showThinking?: boolean;
}

/**
 * Editor for the rich `overrides` field on a step/stage.
 *
 * Two modes:
 *  - Graphical: a list of attribute/value rows with type coercion + a
 *    dedicated ThinkingLevel picker.
 *  - JSON: free-form textarea for the raw overrides object.
 */
export function OverridesEditor({ overrides, onChange, showThinking = true }: Props) {
  const [mode, setMode] = useState<"gui" | "json">("gui");
  const [rows, setRows] = useState<Row[]>([]);
  const [thinking, setThinking] = useState<ThinkingLevel | undefined>(undefined);
  const [jsonText, setJsonText] = useState("");

  // Sync from the incoming overrides prop when it changes externally.
  useEffect(() => {
    setRows(overridesToRows(overrides));
    setThinking(overrides?.thinking);
    setJsonText(overrides ? JSON.stringify(overrides, null, 2) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides]);

  const emitGui = (nextRows: Row[], nextThinking: ThinkingLevel | undefined) => {
    setRows(nextRows);
    setThinking(nextThinking);
    onChange(rowsToOverrides(nextRows, nextThinking));
  };

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
      // keep editing — don't emit an invalid override
    }
  };

  const updateRow = (i: number, patch: Partial<Row>) =>
    emitGui(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)), thinking);

  const addRow = () => emitGui([...rows, { key: "", value: "" }], thinking);

  const removeRow = (i: number) => emitGui(rows.filter((_, idx) => idx !== i), thinking);

  const onThinkingChange = (v: ThinkingLevel | undefined) => emitGui(rows, v);

  const usedKeys = useMemo(() => new Set(rows.map((r) => r.key.trim()).filter(Boolean)), [rows]);
  const availableKeys = (ALL_KEYS as readonly string[]).filter((k) => !usedKeys.has(k));

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="label mb-0">
          Parameter overrides
          <span className="ml-2 normal-case text-ink-500">override top_P, top_K, thinking, etc. for this step</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${mode === "gui" ? "bg-brand-600 text-white" : "border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200"}`}
            onClick={() => setMode("gui")}
          >
            <i className="bi bi-sliders mr-1" />
            Fields
          </button>
          <button
            type="button"
            className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${mode === "json" ? "bg-brand-600 text-white" : "border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200"}`}
            onClick={() => setMode("json")}
          >
            <i className="bi bi-code-slash mr-1" />
            JSON
          </button>
        </div>
      </div>

      {mode === "gui" ? (
        <div className="space-y-2">
          {showThinking && (
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <ThinkingLevelInput
                  value={thinking}
                  onChange={onThinkingChange}
                  hint="override thinking for this step"
                />
              </div>
            </div>
          )}

          {rows.length === 0 && !showThinking && (
            <p className="text-xs text-ink-500">No overrides. Add a field to override request parameters.</p>
          )}

          {rows.map((row, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <select
                className="input h-8 w-36 py-0 text-xs"
                value={row.key}
                onChange={(e) => updateRow(i, { key: e.target.value, value: "" })}
              >
                {row.key === "" && <option value="">— pick a field —</option>}
                {row.key !== "" && !availableKeys.includes(row.key) && (
                  <option value={row.key}>{row.key}</option>
                )}
                {availableKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              {row.key === "thinking" ? (
                <span className="flex-1 text-[11px] text-ink-500">(use the thinking picker above)</span>
              ) : ENUM_KEYS[row.key] ? (
                <select
                  className="input h-8 flex-1 py-0 text-xs"
                  value={row.value}
                  onChange={(e) => updateRow(i, { value: e.target.value })}
                >
                  <option value="">inherit</option>
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
                  placeholder={KEY_HINTS[row.key] ?? "value"}
                />
              )}
              <button
                type="button"
                className="btn-danger btn-xs shrink-0"
                onClick={() => removeRow(i)}
                title="Remove override"
              >
                <i className="bi bi-x-lg" />
              </button>
            </div>
          ))}

          <button type="button" className="btn-ghost btn-xs" onClick={addRow}>
            <i className="bi bi-plus-lg mr-1" />
            Add field
          </button>
        </div>
      ) : (
        <div>
          <textarea
            className="input min-h-[160px] font-mono text-xs"
            value={jsonText}
            onChange={(e) => emitJson(e.target.value)}
            placeholder='{"topP": 0.9, "topK": 40, "maxTokens": 4096}'
          />
          <p className="mt-1 text-[11px] text-ink-600">
            Paste a JSON object. Keys: temperature, topP, topK, minP, maxTokens, stop, frequencyPenalty,
            presencePenalty, repetitionPenalty, seed, n, logprobs, topLogprobs, logitBias, responseFormat,
            parallelToolCalls, serviceTier, user, verbosity, thinking, extra, system.
          </p>
        </div>
      )}
    </div>
  );
}
