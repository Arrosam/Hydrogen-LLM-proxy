import type { Key } from "react";
import { patchAt, removeAt } from "../lib/collections";
import { ACTION_ICON } from "../lib/icons";
import { selectAll } from "../lib/input";
import { keyCounts, type KeyValueRow } from "../lib/kv";
import { Button, Icon } from "./Button";
import { TextInput } from "./inputs";

/** What a call of `onChange` did: an editor that emits on every edit can ignore "add" (an empty row says nothing yet). */
export type KeyValueChange = "add" | "edit" | "remove";

/** The two delete buttons in use: a quiet trash can, or a red x with a tooltip. */
const REMOVE = {
  trash: { variant: "ghost", icon: ACTION_ICON.removeAlt, className: undefined },
  danger: { variant: "danger", icon: ACTION_ICON.close, className: "shrink-0" },
} as const;

/** Classes of a dense row's inputs: 32px high, and a fixed-width key so the values line up. */
const DENSE = { key: "h-8 w-40 py-0", value: "h-8 flex-1 py-0" } as const;
const DUPLICATE_KEY = "border-red-500/70";

export interface KeyValueRowsProps<R extends KeyValueRow> {
  rows: readonly R[];
  onChange: (rows: R[], change: KeyValueChange) => void;
  /** A blank row. Needed when rows carry more than key and value (a stable id). */
  createRow?: () => R;
  /** React key of a row. Default: its index (rows then share input state by position). */
  rowKey?: (row: R, index: number) => Key;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  /**
   * The compact form used inside the service editors: 32px inputs with an
   * explicit `type="text"`, a fixed-width key column, rows aligned to the top,
   * and the add icon set off by a margin instead of the button's gap.
   */
  dense?: boolean;
  /** Select the whole value when its input gains focus. */
  selectValueOnFocus?: boolean;
  removeStyle?: keyof typeof REMOVE;
  removeTitle?: string;
  /**
   * Mark rows that repeat a key (red border, this text as tooltip) and show
   * the text as a warning under the rows. Omitted: duplicates go unremarked.
   */
  duplicateKeyWarning?: string;
  /**
   * Wrap the rows in a container with these classes ("space-y-1.5") and put
   * the add button after it. Omitted: rows, warning and add button are
   * returned as siblings, to sit in the caller's own stack.
   */
  rowsClassName?: string;
  /** Classes of the add button ("mt-1.5"). */
  addClassName?: string;
}

/** Rows of key input + value input + remove, and the button that adds one. */
export function KeyValueRows<R extends KeyValueRow = KeyValueRow>({
  rows,
  onChange,
  createRow = () => ({ key: "", value: "" }) as R,
  rowKey = (_, index) => index,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  dense = false,
  selectValueOnFocus = false,
  removeStyle = "trash",
  removeTitle,
  duplicateKeyWarning,
  rowsClassName,
  addClassName,
}: KeyValueRowsProps<R>) {
  const counts = duplicateKeyWarning === undefined ? null : keyCounts(rows);
  const isDuplicate = (row: R): boolean => (counts?.get(row.key.trim()) ?? 0) > 1;
  const edit = (index: number, patch: Partial<KeyValueRow>): void => onChange(patchAt(rows, index, patch as Partial<R>), "edit");
  const remove = REMOVE[removeStyle];
  const type = dense ? "text" : undefined;

  const rowEls = rows.map((row, i) => {
    const duplicate = isDuplicate(row);
    return (
      <div key={rowKey(row, i)} className={dense ? "flex items-start gap-1.5" : "flex gap-1.5"}>
        <TextInput
          mono
          className={dense ? `${DENSE.key}${duplicate ? ` ${DUPLICATE_KEY}` : ""}` : "flex-1"}
          type={type}
          placeholder={keyPlaceholder}
          title={duplicate ? duplicateKeyWarning : undefined}
          value={row.key}
          onChange={(e) => edit(i, { key: e.target.value })}
        />
        <TextInput
          mono
          className={dense ? DENSE.value : "flex-1"}
          type={type}
          placeholder={valuePlaceholder}
          value={row.value}
          onChange={(e) => edit(i, { value: e.target.value })}
          onFocus={selectValueOnFocus ? selectAll : undefined}
        />
        <Button
          variant={remove.variant}
          size="xs"
          type="button"
          icon={remove.icon}
          className={remove.className}
          title={removeTitle}
          onClick={() => onChange(removeAt(rows, i), "remove")}
        />
      </div>
    );
  });

  return (
    <>
      {rowsClassName === undefined ? rowEls : <div className={rowsClassName}>{rowEls}</div>}
      {counts && [...counts.values()].some((n) => n > 1) && (
        <p className="text-[11px] text-red-400">
          <Icon name="bi-exclamation-triangle" className="mr-1" />
          {duplicateKeyWarning}
        </p>
      )}
      <Button
        variant="ghost"
        size="xs"
        type="button"
        icon={dense ? `${ACTION_ICON.add} mr-1` : ACTION_ICON.add}
        className={addClassName}
        onClick={() => onChange([...rows, createRow()], "add")}
      >
        {addLabel}
      </Button>
    </>
  );
}
