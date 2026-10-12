import { MutedBox } from "./CodeBlock";
import { StatusBadge } from "./common";

export interface HttpInfoBlockProps {
  title: string;
  method?: string | null;
  path?: string | null;
  query?: string | null;
  status?: number;
  headers?: Record<string, string> | null;
  /** Shown in place of the block when nothing at all was captured. */
  emptyLabel: string;
}

/** One side of a captured HTTP exchange: the request or status line, then its headers. */
export function HttpInfoBlock({ title, method, path, query, status, headers, emptyLabel }: HttpInfoBlockProps) {
  const headerEntries = Object.entries(headers ?? {});
  const hasLine = Boolean(method || path || status);
  return (
    <div>
      <h4 className="label">{title}</h4>
      {/* A query is only ever drawn after its path, so one captured alone leaves nothing to show. */}
      {!hasLine && headerEntries.length === 0 ? (
        <MutedBox>{emptyLabel}</MutedBox>
      ) : (
        <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40">
          {hasLine && (
            <div className="flex items-center gap-2 border-b border-ink-800/70 px-3 py-1.5 font-mono text-xs">
              {status != null && <StatusBadge status={status} />}
              {method && <span className="text-brand-400">{method}</span>}
              {path && <span className="text-ink-200">{path}{query ? `?${query}` : ""}</span>}
            </div>
          )}
          {headerEntries.length > 0 && (
            <table className="w-full text-xs">
              <tbody>
                {headerEntries.map(([k, v]) => (
                  <tr key={k} className="border-b border-ink-800/40 last:border-0">
                    <td className="whitespace-nowrap px-3 py-1 align-top font-mono text-ink-400">{k}</td>
                    <td className="break-all px-3 py-1 font-mono text-ink-300">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
