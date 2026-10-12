import { useCallback, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Button";
import { MutedBox } from "../components/CodeBlock";
import { DataTable, type Column } from "../components/DataTable";
import { FilterBar, LiveToggle, RefreshButton } from "../components/FilterBar";
import { CheckboxLabel, TextInput } from "../components/inputs";
import { MetaGrid, MetaTile } from "../components/Meta";
import { AsyncStatus, PageHeader } from "../components/Page";
import { EmptyState, ErrorNote, StatusBadge } from "../components/common";
import { Modal } from "../components/Modal";
import { MS_PER_MINUTE, MS_PER_SECOND } from "../lib/constants";
import { API } from "../lib/endpoints";
import { errorMessage } from "../lib/errors";
import { formatNumber } from "../lib/format";
import { ENTITY_ICON } from "../lib/icons";
import { useI18n } from "../lib/i18n";
import { useLiveQuery } from "../lib/useLiveQuery";

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

/** Poll interval while live: short, because this page is for watching requests move. */
const REFRESH_MS = 500;

/** Decimals of an elapsed time shown in seconds. */
const ELAPSED_SECONDS_DECIMALS = 1;

/** A trace id up to `fullUpTo` characters is shown whole; a longer one as its head and tail. */
const TRACE_ID = { fullUpTo: 20, head: 10, tail: 6 } as const;

/** The HH:MM:SS.mmm part of an ISO timestamp. */
const ISO_CLOCK = { start: 11, end: 23 } as const;

/** The row look of a request that stopped making progress. */
const BLOCKED_ROW = "border-l-4 border-l-red-500 bg-red-950/20";

function phaseBadge(phase: string): string {
  return PHASE_COLORS[phase] ?? "badge-gray";
}

function formatElapsed(ms: number): string {
  if (ms < MS_PER_SECOND) return `${ms}ms`;
  if (ms < MS_PER_MINUTE) return `${(ms / MS_PER_SECOND).toFixed(ELAPSED_SECONDS_DECIMALS)}s`;
  const m = Math.floor(ms / MS_PER_MINUTE);
  const s = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  return `${m}m${s}s`;
}

function shortTrace(traceId: string): string {
  if (traceId.length <= TRACE_ID.fullUpTo) return traceId;
  return `${traceId.slice(0, TRACE_ID.head)}...${traceId.slice(-TRACE_ID.tail)}`;
}

export function ActiveRequests() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [detail, setDetail] = useState<ActiveRequestView | null>(null);
  const [filterTraceId, setFilterTraceId] = useState("");
  const [viewCompleted, setViewCompleted] = useState(false);
  const { t } = useI18n();

  const query = useCallback(() => {
    const params = new URLSearchParams();
    if (filterTraceId) params.set("traceId", filterTraceId);
    const qs = params.toString();
    return api.get<ActiveRequestsResponse>(`${API.activeRequests}${qs ? `?${qs}` : ""}`);
  }, [filterTraceId]);
  const list = useLiveQuery(query, { pollMs: REFRESH_MS, live: autoRefresh });
  const { data, loading } = list;

  const openDetail = async (traceId: string) => {
    try {
      const r = await api.get<ActiveRequestDetail>(API.activeRequest(traceId));
      setDetail(r.request);
    } catch (e) {
      list.setError(errorMessage(e, t("activeRequests.error.loadDetailFailed")));
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
        icon={ENTITY_ICON.activeRequest}
        action={
          <div className="flex items-center gap-3">
            {blockedCount > 0 && (
              <span className="badge-red animate-pulse">
                <Icon name="bi-exclamation-triangle" />
                {t("activeRequests.blockedCount", { count: blockedCount })}
              </span>
            )}
            <LiveToggle
              live={autoRefresh}
              onChange={setAutoRefresh}
              label={t("activeRequests.autoRefreshLabel", { ms: REFRESH_MS })}
              badge={t("activeRequests.liveBadge")}
            />
          </div>
        }
      />

      <FilterBar
        count={
          data
            ? t("activeRequests.countStatus", { active: activeRows.length, completed: completedRows.length })
            : loading
              ? t("activeRequests.loadingStatus")
              : ""
        }
      >
        <TextInput
          mono
          className="w-auto"
          placeholder={t("activeRequests.filterPlaceholder")}
          value={filterTraceId}
          onChange={(e) => setFilterTraceId(e.target.value)}
        />
        <RefreshButton onClick={() => list.reload()}>{t("activeRequests.action.refresh")}</RefreshButton>
        <CheckboxLabel checked={viewCompleted} onChange={setViewCompleted}>
          {t("activeRequests.showCompleted")}
        </CheckboxLabel>
      </FilterBar>

      <AsyncStatus state={list} />
      {!loading && activeRows.length === 0 && !viewCompleted && (
        <EmptyState
          icon={ENTITY_ICON.activeRequest}
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
        size="xl"
        title={detail ? t("activeRequests.modal.detailTitle", { traceId: shortTrace(detail.traceId) }) : ""}
        icon={ENTITY_ICON.activeRequest}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <div className="space-y-4">
            {detail.blocked && !detail.done && (
              <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3">
                <div className="flex items-center gap-2 text-red-400">
                  <Icon name="bi-exclamation-triangle-fill" />
                  <span className="font-semibold">{t("activeRequests.blockedWarning", { elapsed: formatElapsed(detail.elapsedMs) })}</span>
                </div>
                <div className="mt-1 text-xs text-red-300">
                  {t("activeRequests.lastProgress", { phase: detail.lastPhase ?? "", node: detail.lastNode ?? "", message: detail.lastMessage ?? "" })}
                </div>
              </div>
            )}
            {detail.error && <ErrorNote message={detail.error} />}

            <MetaGrid>
              <MetaTile label={t("activeRequests.meta.service")} value={detail.serviceName ?? "-"} />
              <MetaTile label={t("activeRequests.meta.ingress")} value={detail.ingress} />
              <MetaTile label={t("activeRequests.meta.streaming")} value={detail.streaming ? t("common.yes") : t("common.no")} />
              <MetaTile label={t("activeRequests.meta.elapsed")} value={formatElapsed(detail.elapsedMs)} />
              <MetaTile label={t("activeRequests.meta.events")} value={String(detail.eventCount)} />
              <MetaTile label={t("activeRequests.meta.status")} value={detail.done ? String(detail.httpStatus ?? "-") : t("activeRequests.value.inFlight")} />
            </MetaGrid>

            <div>
              <h4 className="label">{t("activeRequests.timelineTitle", { count: detail.events.length })}</h4>
              <div className="max-h-[50vh] space-y-1 overflow-y-auto">
                {detail.events.length === 0 && <MutedBox>{t("activeRequests.noEvents")}</MutedBox>}
                {detail.events.map((ev, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2"
                  >
                    <span className="mt-0.5 text-[11px] font-mono text-ink-500">
                      {new Date(ev.ts).toISOString().slice(ISO_CLOCK.start, ISO_CLOCK.end)}
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
                    <span className="text-[10px] text-ink-600">+{formatNumber(ev.ts - detail.startedAt)}ms</span>
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

function RequestTable({
  rows,
  onRowClick,
}: {
  rows: ActiveRequestView[];
  onRowClick: (traceId: string) => void;
}) {
  const { t } = useI18n();
  const columns: Column<ActiveRequestView>[] = [
    {
      header: t("activeRequests.table.traceId"),
      className: "font-mono text-xs text-ink-200",
      title: (r) => r.traceId,
      cell: (r) => shortTrace(r.traceId),
    },
    { header: t("activeRequests.table.service"), className: "font-mono text-xs text-ink-300", cell: (r) => r.serviceName ?? "-" },
    { header: t("activeRequests.table.phase"), cell: (r) => r.lastPhase && <span className={phaseBadge(r.lastPhase)}>{r.lastPhase}</span> },
    { header: t("activeRequests.table.lastNode"), className: "font-mono text-xs text-ink-400", cell: (r) => r.lastNode ?? "-" },
    {
      header: t("activeRequests.table.elapsed"),
      className: (r) => `text-xs font-medium ${r.blocked ? "text-red-400" : "text-ink-300"}`,
      cell: (r) => (
        <>
          {formatElapsed(r.elapsedMs)}
          {r.blocked && <i className="bi bi-exclamation-triangle ml-1 text-red-400" title={t("activeRequests.blockedTitle")} />}
        </>
      ),
    },
    { header: t("activeRequests.table.events"), className: "text-xs text-ink-400", cell: (r) => r.eventCount },
    {
      header: t("activeRequests.table.status"),
      cell: (r) =>
        r.done ? (
          <StatusBadge status={r.httpStatus ?? 0} />
        ) : r.blocked ? (
          <span className="badge-red">{t("activeRequests.status.blocked")}</span>
        ) : (
          <span className="badge-green">{t("activeRequests.status.serving")}</span>
        ),
    },
    { className: "text-right", cell: () => <Icon name="bi-chevron-right" className="text-ink-600" /> },
  ];
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.traceId}
      columns={columns}
      onRowClick={(r) => onRowClick(r.traceId)}
      rowClassName={(r) => `cursor-pointer ${r.blocked ? BLOCKED_ROW : ""} hover:bg-ink-850/50`}
    />
  );
}
