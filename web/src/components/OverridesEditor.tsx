import { useEffect, useRef, useState } from "react";
import type { Overrides } from "../types";
import { useI18n } from "../lib/i18n";
import { formatJson } from "../lib/json";
import { objectToRows, rowsToObject, type KeyValueRow } from "../lib/kv";
import { SegmentedControl } from "./Chip";
import { InsetPanel, ListHeader } from "./EditorCard";
import { FieldHint } from "./Field";
import { TextArea } from "./inputs";
import { KeyValueRows, type KeyValueChange } from "./KeyValueRows";

/** How the overrides are edited: as key/value rows, or as one JSON object. */
type Mode = "gui" | "json";
const MODE = { fields: "gui", json: "json" } as const;

/** Shown in the empty JSON view. */
const JSON_PLACEHOLDER = '{"topP": 0.9, "topK": 40, "maxTokens": 4096, "thinking": "high"}';

/** A row keeps an id of its own, so React state stays with it when rows above it go. */
interface Row extends KeyValueRow {
  id: number;
}

let rowUid = 1;
const newRow = (row: KeyValueRow = { key: "", value: "" }): Row => ({ id: rowUid++, ...row });

/** The overrides the rows spell: values trimmed and read as JSON when they parse; a row missing either half says nothing. */
function rowsToOverrides(rows: Row[]): Overrides | undefined {
  const out = rowsToObject(rows, { trim: true, dropEmpty: true });
  return Object.keys(out).length ? (out as Overrides) : undefined;
}

const overridesToRows = (ov: Overrides | undefined): Row[] => objectToRows(ov as Record<string, unknown> | undefined).map(newRow);
const overridesToJson = (ov: Overrides | undefined): string => (ov ? formatJson(ov) : "");

interface Props {
  overrides: Overrides | undefined;
  onChange: (ov: Overrides | undefined) => void;
}

export function OverridesEditor({ overrides, onChange }: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>(MODE.fields);
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
    setJsonText(overridesToJson(overrides));
  }, [overrides]);

  // The inactive view goes stale while the other is edited, so rebuild it from
  // the (parent-synced) prop when switching.
  const switchMode = (m: Mode) => {
    if (m === mode) return;
    if (m === MODE.json) setJsonText(overridesToJson(overrides));
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

  // A row just added is empty and says nothing yet, so only edits and removals are emitted.
  const changeRows = (next: Row[], change: KeyValueChange) => {
    setRows(next);
    if (change !== "add") emit(rowsToOverrides(next));
  };

  return (
    <InsetPanel>
      <ListHeader
        label={
          <>
            {t("overrides.title")}
            <span className="ml-2 normal-case text-ink-500">{t("overrides.titleHint")}</span>
          </>
        }
        action={
          <SegmentedControl
            value={mode}
            onChange={switchMode}
            size="fine"
            options={[
              { value: MODE.fields, label: t("overrides.fieldsMode"), icon: "bi-sliders" },
              { value: MODE.json, label: t("overrides.jsonMode"), icon: "bi-code-slash" },
            ]}
          />
        }
      />

      {mode === MODE.fields ? (
        <div className="space-y-2">
          {rows.length === 0 && <p className="text-xs text-ink-500">{t("overrides.emptyHint")}</p>}
          {/* Duplicate parameter names: the last row silently wins, so every involved row is marked. */}
          <KeyValueRows
            dense
            rows={rows}
            onChange={changeRows}
            createRow={newRow}
            rowKey={(row) => row.id}
            keyPlaceholder={t("overrides.paramPlaceholder")}
            valuePlaceholder={t("overrides.contentPlaceholder")}
            addLabel={t("overrides.addField")}
            selectValueOnFocus
            removeStyle="danger"
            removeTitle={t("overrides.removeOverrideTitle")}
            duplicateKeyWarning={t("overrides.duplicateKey")}
          />
          <p className="text-[11px] text-ink-600">{t("overrides.coercionHint")}</p>
        </div>
      ) : (
        <div>
          <TextArea mono className="min-h-[160px]" value={jsonText} onChange={(e) => emitJson(e.target.value)} placeholder={JSON_PLACEHOLDER} />
          <FieldHint tone="faint">{t("overrides.jsonHint")}</FieldHint>
        </div>
      )}
    </InsetPanel>
  );
}
