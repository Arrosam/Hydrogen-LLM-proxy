import { useEffect, useRef, useState } from "react";
import type { Overrides } from "../types";
import { useI18n } from "../lib/i18n";
import { selectAll } from "../lib/input";

interface Row {
  id: number;
  key: string;
  value: string;
}

let rowUid = 1;

function parsesAsJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/** Render a stored value for the text input. Strings that would not survive
 * the plain-text round trip — JSON-parseable, edge whitespace (coerceValue
 * trims), or embedded newlines (a single-line input strips CR/LF) — are shown
 * JSON-quoted so coerceValue restores them exactly. */
function valToString(val: unknown): string {
  if (val === undefined) return "";
  if (typeof val === "string") {
    const fragile = val !== val.trim() || /[\r\n]/.test(val) || parsesAsJson(val);
    return fragile ? JSON.stringify(val) : val;
  }
  return JSON.stringify(val);
}

/** JSON when it parses, plain text otherwise. Quote a value to force a string. */
function coerceValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function rowsToOverrides(rows: Row[]): Overrides | undefined {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    const v = coerceValue(r.value);
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length ? (out as Overrides) : undefined;
}

function overridesToRows(ov: Overrides | undefined): Row[] {
  if (!ov) return [];
  return Object.entries(ov).map(([key, val]) => ({ id: rowUid++, key, value: valToString(val) }));
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

  // A row being typed ("min_p" with no content yet) must survive the parent
  // echoing our own onChange back as a new prop. Track the last value we
  // emitted; only a prop that differs from it is an external change worth
  // resetting the editing state for. The effect records what it accepted so
  // a later external change BACK to an old emission is not mistaken for an
  // echo.
  const lastEmitted = useRef<string>("__init__");
  const emit = (ov: Overrides | undefined) => {
    lastEmitted.current = JSON.stringify(ov ?? null);
    onChange(ov);
  };

  useEffect(() => {
    const incoming = JSON.stringify(overrides ?? null);
    if (incoming === lastEmitted.current) return;
    lastEmitted.current = incoming;
    setRows(overridesToRows(overrides));
    setJsonText(overrides ? JSON.stringify(overrides, null, 2) : "");
  }, [overrides]);

  // The inactive view goes stale while the other is edited, so rebuild it from
  // the (parent-synced) prop when switching.
  const switchMode = (m: "gui" | "json") => {
    if (m === mode) return;
    if (m === "json") setJsonText(overrides ? JSON.stringify(overrides, null, 2) : "");
    else setRows(overridesToRows(overrides));
    setMode(m);
  };

  const emitJson = (text: string) => {
    setJsonText(text);
    const trimmed = text.trim();
    if (trimmed === "") {
      emit(undefined);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // keep editing
    }
    // Overrides is an object patch; null/arrays/scalars would persist and then
    // bounce off the server's schema, so don't emit them.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    emit(parsed as Overrides);
  };

  const updateRow = (i: number, patch: Partial<Row>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setRows(next);
    emit(rowsToOverrides(next));
  };

  const addRow = () => {
    setRows([...rows, { id: rowUid++, key: "", value: "" }]);
  };

  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next);
    emit(rowsToOverrides(next));
  };

  // Duplicate parameter names: the last row silently wins in rowsToOverrides,
  // so mark every involved row instead of losing a value without warning.
  const keyCounts = new Map<string, number>();
  for (const r of rows) {
    const k = r.key.trim();
    if (k) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
  }
  const hasDuplicates = [...keyCounts.values()].some((n) => n > 1);

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
            onClick={() => switchMode("gui")}
          >
            <i className="bi bi-sliders mr-1" />
            {t("overrides.fieldsMode")}
          </button>
          <button
            type="button"
            className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${mode === "json" ? "bg-brand-600 text-white" : "border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200"}`}
            onClick={() => switchMode("json")}
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
            const dup = (keyCounts.get(row.key.trim()) ?? 0) > 1;
            return (
              <div key={row.id} className="flex items-start gap-1.5">
                <input
                  className={`input h-8 w-40 py-0 font-mono text-xs ${dup ? "border-red-500/70" : ""}`}
                  type="text"
                  placeholder={t("overrides.paramPlaceholder")}
                  title={dup ? t("overrides.duplicateKey") : undefined}
                  value={row.key}
                  onChange={(e) => updateRow(i, { key: e.target.value })}
                />
                <input
                  className="input h-8 flex-1 py-0 font-mono text-xs"
                  type="text"
                  value={row.value}
                  onChange={(e) => updateRow(i, { value: e.target.value })}
                  onFocus={selectAll}
                  placeholder={t("overrides.contentPlaceholder")}
                />
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

          {hasDuplicates && (
            <p className="text-[11px] text-red-400">
              <i className="bi bi-exclamation-triangle mr-1" />
              {t("overrides.duplicateKey")}
            </p>
          )}

          <button type="button" className="btn-ghost btn-xs" onClick={addRow}>
            <i className="bi bi-plus-lg mr-1" />
            {t("overrides.addField")}
          </button>

          <p className="text-[11px] text-ink-600">{t("overrides.coercionHint")}</p>
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
