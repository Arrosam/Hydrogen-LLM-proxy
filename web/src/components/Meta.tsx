import type { ReactNode } from "react";

/** The three-column grid of facts at the top of a detail modal. */
export function MetaGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-3 gap-3 text-sm">{children}</div>;
}

/** One fact of a `MetaGrid`: a micro caption over its value. */
export function MetaTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-ink-950/50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className="mt-0.5 text-ink-200">{value}</div>
    </div>
  );
}
