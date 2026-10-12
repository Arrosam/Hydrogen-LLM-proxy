import { Fragment, type Key, type ReactNode } from "react";

export interface Column<T> {
  /** Column heading; omitted = an empty header cell (a trailing chevron column). */
  header?: ReactNode;
  /** Classes of the <th> ("text-right" over an actions column). */
  headerClassName?: string;
  cell: (row: T, index: number) => ReactNode;
  /** Classes of each <td>, fixed or per row. */
  className?: string | ((row: T) => string | undefined);
  /** `title` attribute of each <td> (the full text of a truncated cell). */
  title?: (row: T) => string | undefined;
  /** Leave the column out entirely (a column that only exists for some data). */
  hidden?: boolean;
}

export interface DataTableProps<T> {
  rows: readonly T[];
  rowKey: (row: T, index: number) => Key;
  columns: readonly Column<T>[];
  /** Makes rows clickable. The row's look (cursor, hover) comes from `rowClassName`. */
  onRowClick?: (row: T, index: number) => void;
  rowClassName?: string | ((row: T, index: number) => string | undefined);
  /** A detail row under `row` spanning every column; null/false = none. */
  expanded?: (row: T, index: number) => ReactNode;
  /** Classes of the detail row's single cell. */
  expandedClassName?: string;
}

const resolve = <A extends unknown[]>(v: string | ((...a: A) => string | undefined) | undefined, ...a: A): string | undefined =>
  typeof v === "function" ? v(...a) : v;

/** The `card` + `table` every list page draws, described as columns. */
export function DataTable<T>({ rows, rowKey, columns, onRowClick, rowClassName, expanded, expandedClassName }: DataTableProps<T>) {
  const shown = columns.filter((c) => !c.hidden);
  return (
    <div className="card overflow-hidden">
      <table className="table">
        <thead>
          <tr>
            {shown.map((c, i) => (
              <th key={i} className={c.headerClassName}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const detail = expanded?.(row, index);
            return (
              <Fragment key={rowKey(row, index)}>
                <tr className={resolve(rowClassName, row, index)} onClick={onRowClick ? () => onRowClick(row, index) : undefined}>
                  {shown.map((c, i) => (
                    <td key={i} className={resolve(c.className, row)} title={c.title?.(row)}>
                      {c.cell(row, index)}
                    </td>
                  ))}
                </tr>
                {detail ? (
                  <tr>
                    <td colSpan={shown.length} className={expandedClassName}>
                      {detail}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
