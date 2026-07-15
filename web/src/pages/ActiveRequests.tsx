import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, StatusBadge, Toggle } from "../components/common";
import { Modal } from "../components/Modal";
import { useI18n } from "../lib/i18n";

/** One progress event in a request's lifecycle. */
interface ProgressEvent {
  ts: number;
  phase: string;
  node: string;
  message: string;
  detail?: Record<string, unknown>;
}

/** A serialized active request (mirrors the server's serializeActive). */
interface ActiveRequestView {
  traceId: string;
  tokenId: number | null;
  serviceId: number | null;
  serviceName: string | null;
  ingress: string;
  streaming: boolean;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  blocked: boolean;
  done: boolean;
  httpStatus: number | null;
  error: string | null;
  eventCount: number;
  lastPhase: string | null;
  lastNode: string | null;
  lastMessage: string | null;
  lastEventTs: number | null;
  events: ProgressEvent[];
}

interface ActiveRequestsResponse {
  active: ActiveRequestView[];
  completed: ActiveRequestView[];
  blockThresholdMs: number;
  now: number;
}

interface ActiveRequestDetail {
  request: ActiveRequestView;
  blockThresholdMs: number;
}

const PHASE_COLORS: Record<string, string> = {
  init: "badge-blue",
  agent: "badge-purple",
  llm: "badge-green",
  retry: "badge-yellow",
  done: "badge-gray",
  error: "badge-red",
};

function phaseBadge(phase: string): string {
  return PHASE_COLORS[phase] ?? "badge-gray";
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function shortTrace(traceId: string): string {
  if (traceId.length <= 20) return traceId;
  return `${traceId.slice(0, 10)}...${traceId.slice(-6)}`;
}

export function ActiveRequests() {
  const REFRESH_MS = 500;
  const [data, setData] = useState<ActiveRequestsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [detail, setDetail] = useState<ActiveRequestView | null>(null);
  const [filterTraceId, setFilterTraceId] = useState("");
  const [viewCompleted, setViewCompleted] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { t } = useI18n();

  const load = useCallback(
    (silent = false) => {
      const params = new URLSearchParams();
      if (filterTraceId) params.set("traceId", filterTraceId);
      const qs = params.toString();
      const url = `/active-requests${qs ? `?${qs}` : ""}`;
      if (!silent) setLoading(true);
      api
        .get<ActiveRequestsResponse>(url)
        .then((r) => {
          setData(r);
          setError(null);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          if (!silent) setLoading(false);
        });
    },
    [filterTraceId],
  );

  // Initial load + reload on filter change.
  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh at <= 500ms interval (real-time monitoring).
  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => load(true), REFRESH_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, load]);

  const openDetail = async (traceId: string) => {
    try {
      const r = await api.get<ActiveRequestDetail>(`/active-requests/${traceId}`);
      setDetail(r.request);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("activeRequests.error.loadDetailFailed"));
    }
  };

  const activeRows = data?.active ?? [];
  const completedRows = data?.completed ?? [];
  const blockedCount = activeRows.filter((r) => r.blocked).length;

  return (
    <div>
      <PageHeader
        title={t("activeRequests.title")}
        subtitle={t("activeRequests.subtitle")}
        icon="bi-activity"
        action={
          <div className="flex items-center gap-3">
            {blockedCount > 0 && (
              <span className="badge-red animate-pulse">
                <i className="bi bi-exclamation-triangle" />
                {t("activeRequests.blockedCount", { count: blockedCount })}
              </span>
            )}
            <Toggle checked={autoRefresh} onChange={setAutoRefresh} label={t("activeRequests.autoRefreshLabel", { ms: REFRESH_MS })} />
            {autoRefresh && (
              <span className="badge-green">
                <i className="bi bi-broadcast" />
                {t("activeRequests.liveBadge")}
              </span>
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          className="input w-auto font-mono text-xs"
          placeholder={t("activeRequests.filterPlaceholder")}
          value={filterTraceId}
          onChange={(e) => setFilterTraceId(e.target.value)}
        />
        <button className="btn-ghost btn-xs" onClick={() => load()}>
          <i className="bi bi-arrow-clockwise" />
          {t("activeRequests.action.refresh")}
        </button>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={viewCompleted} onChange={(e) => setViewCompleted(e.target.checked)} />
          {t("activeRequests.showCompleted")}
        </label>
        <div className="flex-1" />
        <span className="text-xs text-ink-500">
          {data ? t("activeRequests.countStatus", { active: activeRows.length, completed: completedRows.length }) : t("activeRequests.loadingStatus")}
        </span>
      </div>

      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {!loading && activeRows.length === 0 && !viewCompleted && (
        <EmptyState
          icon="bi-activity"
          title={t("activeRequests.empty.activeTitle")}
          hint={t("activeRequests.empty.activeHint")}
        />
      )}

      {activeRows.length > 0 && <RequestTable rows={activeRows} onRowClick={openDetail} />}

      {viewCompleted && (
        <>
          <h3 className="mb-2 mt-6 text-sm font-medium text-ink-400">
            {t("activeRequests.recentlyCompleted")}
            <span className="ml-2 text-xs text-ink-600">{completedRows.length}</span>
          </h3>
          {!loading && completedRows.length === 0 ? (
            <EmptyState
              icon="bi-check2-circle"
              title={t("activeRequests.empty.completedTitle")}
              hint={t("activeRequests.empty.completedHint")}
            />
          ) : (
            <RequestTable rows={completedRows} onRowClick={openDetail} />
          )}
        </>
      )}

      {/* Progress event stream detail modal */}
      <Modal
        open={detail !== null}
        wide
        title={detail ? t("activeRequests.modal.detailTitle", { traceId: shortTrace(detail.traceId) }) : ""}
        icon="bi-activity"
        onClose={() => setDetail(null)}
      >
        {detail && (
          <div className="space-y-4">
            {detail.blocked && !detail.done && (
              <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3">
                <div className="flex items-center gap-2 text-red-400">
                  <i className="bi bi-exclamation-triangle-fill" />
                  <span className="font-semibold">{t("activeRequests.blockedWarning", { elapsed: formatElapsed(detail.elapsedMs) })}</span>
                </div>
                <div className="mt-1 text-xs text-red-300">
                  {t("activeRequests.lastProgress", { phase: detail.lastPhase ?? "", node: detail.lastNode ?? "", message: detail.lastMessage ?? "" })}
                </div>
              </div>
            )}
            {detail.error && <ErrorNote message={detail.error} />}

            <div className="grid grid-cols-3 gap-3 text-sm">
              <Meta label={t("activeRequests.meta.service")} value={detail.serviceName ?? "-"} />
              <Meta label={t("activeRequests.meta.ingress")} value={detail.ingress} />
              <Meta label={t("activeRequests.meta.streaming")} value={detail.streaming ? t("common.yes") : t("common.no")} />
              <Meta label={t("activeRequests.meta.elapsed")} value={formatElapsed(detail.elapsedMs)} />
              <Meta label={t("activeRequests.meta.events")} value={String(detail.eventCount)} />
              <Meta label={t("activeRequests.meta.status")} value={detail.done ? String(detail.httpStatus) : t("activeRequests.value.inFlight")} />
            </div>

            <div>
              <h4 className="label">{t("activeRequests.timelineTitle", { count: detail.events.length })}</h4>
              <div className="max-h-[50vh] space-y-1 overflow-y-auto">
                {detail.events.length === 0 && (
                  <div className="rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-500">{t("activeRequests.noEvents")}</div>
                )}
                {detail.events.map((ev, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2"
                  >
                    <span className="mt-0.5 text-[11px] font-mono text-ink-500">
                      {new Date(ev.ts).toISOString().slice(11, 23)}
                    </span>
                    <span className={`mt-0.5 shrink-0 ${phaseBadge(ev.phase)}`}>{ev.phase}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs text-brand-400">{ev.node}</div>
                      <div className="text-xs text-ink-200">{ev.message}</div>
                      {ev.detail && Object.keys(ev.detail).length > 0 && (
                        <pre className="mt-1 overflow-auto rounded bg-ink-950 px-2 py-1 text-[10px] text-ink-400">
                          {JSON.stringify(ev.detail)}
                        </pre>
                      )}
                    </div>
                    <span className="text-[10px] text-ink-600">+{(ev.ts - detail.startedAt).toLocaleString()}ms</span>
                  </div>
                ))}
              </div>
            </div>
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

function RequestTable({
  rows,
  onRowClick,
}: {
  rows: ActiveRequestView[];
  onRowClick: (traceId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="card overflow-hidden">
      <table className="table">
        <thead>
          <tr>
            <th>{t("activeRequests.table.traceId")}</th>
            <th>{t("activeRequests.table.service")}</th>
            <th>{t("activeRequests.table.phase")}</th>
            <th>{t("activeRequests.table.lastNode")}</th>
            <th>{t("activeRequests.table.elapsed")}</th>
            <th>{t("activeRequests.table.events")}</th>
            <th>{t("activeRequests.table.status")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.traceId}
              className={`cursor-pointer ${r.blocked ? "border-l-4 border-l-red-500 bg-red-950/20" : ""} hover:bg-ink-850/50`}
              onClick={() => onRowClick(r.traceId)}
            >
              <td className="font-mono text-xs text-ink-200" title={r.traceId}>
                {shortTrace(r.traceId)}
              </td>
              <td className="font-mono text-xs text-ink-300">{r.serviceName ?? "-"}</td>
              <td>
                {r.lastPhase && <span className={phaseBadge(r.lastPhase)}>{r.lastPhase}</span>}
              </td>
              <td className="font-mono text-xs text-ink-400">{r.lastNode ?? "-"}</td>
              <td className={`text-xs font-medium ${r.blocked ? "text-red-400" : "text-ink-300"}`}>
                {formatElapsed(r.elapsedMs)}
                {r.blocked && <i className="bi bi-exclamation-triangle ml-1 text-red-400" title={t("activeRequests.blockedTitle")} />}
              </td>
              <td className="text-xs text-ink-400">{r.eventCount}</td>
              <td>
                {r.done ? (
                  <StatusBadge status={r.httpStatus ?? 0} />
                ) : r.blocked ? (
                  <span className="badge-red">{t("activeRequests.status.blocked")}</span>
                ) : (
                  <span className="badge-green">{t("activeRequests.status.serving")}</span>
                )}
              </td>
              <td className="text-right">
                <i className="bi bi-chevron-right text-ink-600" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
