import type { ReactNode } from "react";
import { ACTION_ICON } from "../lib/icons";
import { Button, Icon } from "./Button";
import { Toggle } from "./common";

/**
 * The row of controls over a list: filters on the left, then (pushed right) a
 * count and any bulk action.
 */
export function FilterBar({ children, count, end }: { children: ReactNode; count: ReactNode; end?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      {children}
      <div className="flex-1" />
      <span className="text-xs text-ink-500">{count}</span>
      {end}
    </div>
  );
}

/** "Reload now", beside the filters. */
export function RefreshButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="xs" icon={ACTION_ICON.refresh} onClick={onClick}>
      {children}
    </Button>
  );
}

/** The auto-refresh switch and, while it is on, the green "live" badge. */
export function LiveToggle({ live, onChange, label, badge }: { live: boolean; onChange: (live: boolean) => void; label: string; badge: string }) {
  return (
    <>
      <Toggle checked={live} onChange={onChange} label={label} />
      {live && (
        <span className="badge-green">
          <Icon name={ACTION_ICON.live} />
          {badge}
        </span>
      )}
    </>
  );
}

export interface PaginationProps {
  /** Index of the first row shown. */
  offset: number;
  pageSize: number;
  total: number;
  onChange: (offset: number) => void;
  labels: { prev: string; next: string; summary: (range: { start: number; end: number }) => string };
}

/** Previous / "a-b of n" / next. Renders nothing while everything fits on one page. */
export function Pagination({ offset, pageSize, total, onChange, labels }: PaginationProps) {
  if (total <= pageSize) return null;
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-ink-400">
      <Button variant="ghost" size="xs" icon="bi-chevron-left" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - pageSize))}>
        {labels.prev}
      </Button>
      <span>{labels.summary({ start: offset + 1, end: Math.min(offset + pageSize, total) })}</span>
      <Button variant="ghost" size="xs" trailingIcon="bi-chevron-right" disabled={offset + pageSize >= total} onClick={() => onChange(offset + pageSize)}>
        {labels.next}
      </Button>
    </div>
  );
}
