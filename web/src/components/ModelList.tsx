import { useMemo, useState } from "react";
import { useI18n } from "../lib/i18n";

/** Rows rendered at once. A gateway can report thousands of models; the search
 * box is the way through them, not a scrollbar the length of a novel. */
const RENDER_LIMIT = 200;

interface ModelListProps {
  models: string[];
  /** Filter text owned by the caller. When set, the built-in search box is
   * hidden — the caller's own input is doing the searching. */
  filter?: string;
  /** Highlighted entry. */
  selected?: string;
  /** Makes rows clickable. Omit for a read-only list. */
  onPick?: (model: string) => void;
  /** Shown when there is nothing to list at all. */
  emptyText: string;
}

/**
 * A searchable, scrollable list of upstream model ids. Used read-only to show
 * what a provider just reported, and as a picker when mapping a model to it.
 */
export function ModelList({ models, filter, selected, onPick, emptyText }: ModelListProps) {
  const { t } = useI18n();
  const [ownQuery, setOwnQuery] = useState("");
  const controlled = filter !== undefined;
  const query = (controlled ? filter : ownQuery).trim().toLowerCase();

  const matches = useMemo(
    () => (query ? models.filter((m) => m.toLowerCase().includes(query)) : models),
    [models, query],
  );
  const shown = matches.slice(0, RENDER_LIMIT);
  const hidden = matches.length - shown.length;

  if (models.length === 0) {
    return <p className="rounded-lg border border-dashed border-ink-700 px-3 py-2.5 text-xs text-ink-500">{emptyText}</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-ink-700 bg-ink-950/40">
      {!controlled && (
        <div className="border-b border-ink-800 p-2">
          <input
            className="input py-1.5 text-xs"
            value={ownQuery}
            onChange={(e) => setOwnQuery(e.target.value)}
            placeholder={t("modelList.search")}
          />
        </div>
      )}
      {matches.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-ink-500">{t("modelList.noMatch", { query: query })}</p>
      ) : (
        <ul className="max-h-48 overflow-y-auto">
          {shown.map((m) => {
            const isSelected = m === selected;
            const cls = `flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs ${
              isSelected ? "bg-brand-700/25 text-brand-400" : "text-ink-300"
            }`;
            return (
              <li key={m}>
                {onPick ? (
                  <button type="button" className={`${cls} hover:bg-ink-800`} onClick={() => onPick(m)}>
                    <i className={`bi ${isSelected ? "bi-check-lg" : "bi-dot"} shrink-0`} />
                    <span className="truncate">{m}</span>
                  </button>
                ) : (
                  <span className={cls}>
                    <i className="bi bi-dot shrink-0" />
                    <span className="truncate">{m}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && (
        <p className="border-t border-ink-800 px-3 py-1.5 text-xs text-ink-500">{t("modelList.more", { count: hidden })}</p>
      )}
    </div>
  );
}
