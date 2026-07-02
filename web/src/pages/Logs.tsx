import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, Toggle } from "../components/common";
import { Modal } from "../components/Modal";
import { formatNumber, relativeTime } from "../lib/format";
import { parsePayload, type PayloadMeta } from "../lib/payload";
import type { LogSummary, Mub } from "../types";

interface AttemptRecord {
  step: number;
  attempt: number;
  model: string;
  provider: string;
  status: number;
  kind: string;
  latencyMs: number;
  error?: string;
}

interface LogDetail extends LogSummary {
  attemptPath: AttemptRecord[] | null;
  requestPayload: string | null;
  responsePayload: string | null;
}

type PayloadView = "formatted" | "json";

function statusBadge(status: number) {
  if (status >= 200 && status < 300) return <span className="badge-green">{status}</span>;
  if (status === 499) return <span className="badge-gray">{status}</span>;
  return <span className="badge-red">{status}</span>;
}

function pretty(json: string | null): string {
  if (!json) return "-";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export function Logs() {
  const PAGE = 50;
  const [rows, setRows] = useState<LogSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [mubId, setMubId] = useState<number | "">("");
  const [mubs, setMubs] = useState<Mub[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [payloadView, setPayloadView] = useState<PayloadView>("formatted");

  useEffect(() => {
    api.get<{ mubs: Mub[] }>("/mubs").then((r) => setMubs(r.mubs)).catch(() => {});
  }, []);

  const load = useCallback(
    (silent = false) => {
      if (!silent) setLoading(true);
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (errorsOnly) params.set("errorsOnly", "true");
      if (mubId !== "") params.set("mubId", String(mubId));
      api
        .get<{ rows: LogSummary[]; total: number }>(`/logs?${params.toString()}`)
        .then((r) => {
          setRows(r.rows);
          setTotal(r.total);
          setError(null);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          if (!silent) setLoading(false);
        });
    },
    [offset, errorsOnly, mubId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh every 5s (silent - no spinner flicker) when enabled.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => load(true), 5000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const openDetail = async (id: number) => {
    const r = await api.get<{ log: LogDetail }>(`/logs/${id}`);
    setDetail(r.log);
  };

  const mubName = (id: number | null) => (id == null ? "-" : mubs.find((m) => m.id === id)?.name ?? `#${id}`);

  return (
    <div>
      <PageHeader title="Logs" subtitle="Every request, its resolved attempt path, and payloads." icon="bi-journal-text" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          className="input w-auto"
          value={mubId}
          onChange={(e) => {
            setOffset(0);
            setMubId(e.target.value === "" ? "" : Number(e.target.value));
          }}
        >
          <option value="">All MUBs</option>
          {mubs.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => { setOffset(0); setErrorsOnly(e.target.checked); }} />
          Errors only
        </label>
        <button className="btn-ghost btn-xs" onClick={() => load()}>
          <i className="bi bi-arrow-clockwise" />
          Refresh
        </button>
        <Toggle checked={autoRefresh} onChange={setAutoRefresh} label="Auto-refresh (5s)" />
        {autoRefresh && (
          <span className="badge-green">
            <i className="bi bi-broadcast" />
            live
          </span>
        )}
        <div className="flex-1" />
        <span className="text-xs text-ink-500">{formatNumber(total)} total</span>
      </div>

      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {!loading && rows.length === 0 && <EmptyState icon="bi-journal-text" title="No log entries" hint="Requests through your MUB endpoints appear here." />}

      {rows.length > 0 && (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>MUB</th>
                <th>Route</th>
                <th>Status</th>
                <th>Tokens</th>
                <th>Latency</th>
                <th>Tries</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer" onClick={() => openDetail(r.id)}>
                  <td className="whitespace-nowrap text-xs text-ink-400">{relativeTime(r.createdAt)}</td>
                  <td className="font-mono text-xs text-ink-200">{r.mubName ?? mubName(r.mubId)}</td>
                  <td className="text-xs">
                    <span className="text-ink-300">{r.ingressFormat}</span>
                    <i className="bi bi-arrow-right mx-1 text-ink-600" />
                    <span className="text-ink-400">{r.egressFormat ?? "-"}</span>
                    {r.streaming && <i className="bi bi-broadcast ml-2 text-brand-400" title="streaming" />}
                  </td>
                  <td>{statusBadge(r.httpStatus)}</td>
                  <td className="text-xs text-ink-300">{formatNumber(r.totalTokens)}</td>
                  <td className="text-xs text-ink-400">{r.latencyMs} ms</td>
                  <td className="text-xs text-ink-400">{r.attempts}</td>
                  <td className="text-right"><i className="bi bi-chevron-right text-ink-600" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-400">
          <button className="btn-ghost btn-xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            <i className="bi bi-chevron-left" />Prev
          </button>
          <span>{offset + 1}-{Math.min(offset + PAGE, total)} of {formatNumber(total)}</span>
          <button className="btn-ghost btn-xs" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            Next<i className="bi bi-chevron-right" />
          </button>
        </div>
      )}

      <Modal open={detail !== null} wide title={`Request #${detail?.id}`} icon="bi-journal-text" onClose={() => setDetail(null)}>
        {detail && (
          <div className="space-y-4">
            {detail.error && <ErrorNote message={detail.error} />}
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Meta label="MUB" value={detail.mubName ?? "-"} />
              <Meta label="Status" value={String(detail.httpStatus)} />
              <Meta label="Latency" value={`${detail.latencyMs} ms`} />
              <Meta label="Route" value={`${detail.ingressFormat} -> ${detail.egressFormat ?? "-"}`} />
              <Meta label="Streaming" value={detail.streaming ? "yes" : "no"} />
              <Meta label="Tokens" value={`${detail.promptTokens} + ${detail.completionTokens} = ${detail.totalTokens}`} />
            </div>

            <div>
              <h4 className="label">Attempt path</h4>
              <div className="card overflow-hidden">
                <table className="table">
                  <thead>
                    <tr><th>Step</th><th>Try</th><th>Model</th><th>Provider</th><th>Result</th><th>Latency</th></tr>
                  </thead>
                  <tbody>
                    {(detail.attemptPath ?? []).map((a, i) => (
                      <tr key={i}>
                        <td>{a.step}</td>
                        <td>{a.attempt}</td>
                        <td className="font-mono text-xs">{a.model}</td>
                        <td className="font-mono text-xs">{a.provider}</td>
                        <td>{a.kind === "ok" ? <span className="badge-green">ok</span> : <span className="badge-red">{a.status || a.kind}</span>}</td>
                        <td className="text-xs text-ink-400">{a.latencyMs} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <h4 className="label mb-0">Payloads</h4>
              <div className="inline-flex rounded-lg border border-ink-700 p-0.5 text-xs">
                {(["formatted", "json"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setPayloadView(v)}
                    className={`rounded-md px-2.5 py-1 font-medium capitalize transition-colors ${
                      payloadView === v ? "bg-brand-600 text-white" : "text-ink-400 hover:text-ink-200"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            <PayloadBlock title="Request payload" raw={detail.requestPayload} view={payloadView} />
            <PayloadBlock title="Response payload" raw={detail.responsePayload} view={payloadView} />
          </div>
        )}
      </Modal>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-ink-950/50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className="mt-0.5 text-ink-200">{value}</div>
    </div>
  );
}

function roleBadge(role: string): string {
  switch (role) {
    case "user":
      return "badge-blue";
    case "assistant":
      return "badge-green";
    default:
      return "badge-gray";
  }
}

function Transcript({ data }: { data: PayloadMeta }) {
  return (
    <div className="space-y-3">
      {data.meta.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.meta.map((m) => (
            <span key={m.label} className="badge-gray">
              <span className="text-ink-500">{m.label}:</span> {m.value}
            </span>
          ))}
        </div>
      )}
      {data.tools.length > 0 && (
        <details className="rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-ink-300">
            <i className="bi bi-tools mr-1 text-ink-500" />
            {data.tools.length} tool{data.tools.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {data.tools.map((t) => (
              <span key={t} className="badge-gray font-mono">{t}</span>
            ))}
          </div>
        </details>
      )}
      <div className="space-y-2">
        {data.turns.map((t, i) => (
          <div key={i} className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40">
            <div className="flex items-center gap-2 border-b border-ink-800/70 px-3 py-1.5">
              <span className={roleBadge(t.role)}>{t.role}</span>
              <span className="text-[11px] text-ink-600">{t.text.length.toLocaleString()} chars</span>
            </div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-ink-200">{t.text || "(empty)"}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function PayloadBlock({ title, raw, view }: { title: string; raw: string | null; view: PayloadView }) {
  const parsed = useMemo(() => parsePayload(raw), [raw]);
  const showFormatted = view === "formatted" && parsed;
  return (
    <div>
      <h4 className="label">{title}</h4>
      {raw == null ? (
        <div className="rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-500">— not recorded —</div>
      ) : showFormatted ? (
        <Transcript data={parsed} />
      ) : (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs leading-relaxed text-ink-300">{pretty(raw)}</pre>
      )}
    </div>
  );
}
