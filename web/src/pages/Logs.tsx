import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, StatusBadge, Toggle, useConfirm } from "../components/common";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useAuth } from "../auth";
import { formatNumber, relativeTime } from "../lib/format";
import { parsePayload, type PayloadMeta } from "../lib/payload";
import { useI18n } from "../lib/i18n";
import type { LogSummary, ModelService } from "../types";

interface AttemptRecord {
  step: number;
  attempt: number;
  model: string;
  provider: string;
  status: number;
  kind: string;
  latencyMs: number;
  error?: string;
  // Legacy Micro Agent logs (pre-0.4) tacked stage info onto flat records.
  stage?: string;
  service?: string;
  request?: string;
  response?: string;
}

/** One Model Service call made by a Micro Agent (each with its own attempt path). */
interface ServiceCallEntry {
  stage: string;
  service: string;
  kind: "service" | "agent" | "router";
  status: number;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  attempts: AttemptRecord[];
  request?: string;
  response?: string;
  error?: string;
  calls?: ServiceCallEntry[];
  streamed?: boolean;
}

interface LogDetail extends LogSummary {
  attemptPath: unknown;
  requestPayload: string | null;
  upstreamRequestPayload: string | null;
  responsePayload: string | null;
  // Full HTTP request/response capture (API keys redacted by the backend).
  requestMethod: string | null;
  requestPath: string | null;
  requestQuery: string | null;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  traceId: string | null;
  servedModel: string | null;
  servedProvider: string | null;
}

type PayloadView = "formatted" | "json";

/** Micro Agent logs store an array of Model Service calls; Model Service logs
 * (and legacy agent logs) store a flat attempt list. */
function isCallLog(path: unknown): path is ServiceCallEntry[] {
  return (
    Array.isArray(path) &&
    path.length > 0 &&
    typeof path[0] === "object" &&
    path[0] !== null &&
    Array.isArray((path[0] as { attempts?: unknown }).attempts)
  );
}

/** Result cell for one upstream attempt ("ok" or its failure status/kind). */
function attemptBadge(a: AttemptRecord) {
  const { t } = useI18n();
  if (a.kind === "ok") return <StatusBadge status={200} label={t("logs.badge.ok")} />;
  return <StatusBadge status={a.status} label={String(a.status || a.kind)} />;
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
  const [serviceId, setServiceId] = useState<number | "">("");
  const [services, setServices] = useState<ModelService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [payloadView, setPayloadView] = useState<PayloadView>("formatted");
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [clearing, setClearing] = useState(false);
  const toast = useToast();
  const { user } = useAuth();
  const { confirm, confirmEl } = useConfirm();
  const { t } = useI18n();

  const toggleRow = (i: number) =>
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  useEffect(() => {
    api.get<{ services: ModelService[] }>("/services").then((r) => setServices(r.services)).catch(() => {});
  }, []);

  const load = useCallback(
    (silent = false) => {
      if (!silent) setLoading(true);
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (errorsOnly) params.set("errorsOnly", "true");
      if (serviceId !== "") params.set("serviceId", String(serviceId));
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
    [offset, errorsOnly, serviceId],
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
    setExpandedRows(new Set());
    setDetail(r.log);
  };

  const serviceName = (id: number | null) => (id == null ? "-" : services.find((m) => m.id === id)?.name ?? `#${id}`);

  const clearAll = async () => {
    const ok = await confirm(
      t("logs.confirm.clearAllTitle"),
      t("logs.confirm.clearAllBody", { total: formatNumber(total) }),
    );
    if (!ok) return;
    setClearing(true);
    try {
      const r = await api.del<{ deleted: number }>("/logs");
      toast.success(t("logs.toast.deleted", { count: formatNumber(r.deleted) }));
      setOffset(0);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("logs.toast.clearFailed"));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div>
      <PageHeader title={t("logs.title")} subtitle={t("logs.subtitle")} icon="bi-journal-text" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          className="input w-auto"
          value={serviceId}
          onChange={(e) => {
            setOffset(0);
            setServiceId(e.target.value === "" ? "" : Number(e.target.value));
          }}
        >
          <option value="">{t("logs.filter.allServices")}</option>
          {services.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => { setOffset(0); setErrorsOnly(e.target.checked); }} />
          {t("logs.filter.errorsOnly")}
        </label>
        <button className="btn-ghost btn-xs" onClick={() => load()}>
          <i className="bi bi-arrow-clockwise" />
          {t("logs.action.refresh")}
        </button>
        <Toggle checked={autoRefresh} onChange={setAutoRefresh} label={t("logs.autoRefreshLabel")} />
        {autoRefresh && (
          <span className="badge-green">
            <i className="bi bi-broadcast" />
            {t("logs.liveBadge")}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-xs text-ink-500">{formatNumber(total)} {t("logs.totalCount")}</span>
        {user?.role === "admin" && (
          <button className="btn-danger btn-xs" onClick={clearAll} disabled={clearing || total === 0} title={t("logs.action.clearAllTitle")}>
            <i className={`bi ${clearing ? "bi-arrow-repeat animate-spin" : "bi-trash3"}`} />
            {t("logs.action.clearAll")}
          </button>
        )}
      </div>

      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {!loading && rows.length === 0 && <EmptyState icon="bi-journal-text" title={t("logs.empty.title")} hint={t("logs.empty.hint")} />}

      {rows.length > 0 && (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>{t("logs.table.time")}</th>
                <th>{t("logs.table.service")}</th>
                <th>{t("logs.table.route")}</th>
                <th>{t("logs.table.status")}</th>
                <th>{t("logs.table.tokens")}</th>
                <th>{t("logs.table.latency")}</th>
                <th>{t("logs.table.tries")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer" onClick={() => openDetail(r.id)}>
                  <td className="whitespace-nowrap text-xs text-ink-400">{relativeTime(r.createdAt)}</td>
                  <td className="font-mono text-xs text-ink-200">{r.serviceName ?? serviceName(r.serviceId)}</td>
                  <td className="text-xs">
                    <span className="text-ink-300">{r.ingressFormat}</span>
                    <i className="bi bi-arrow-right mx-1 text-ink-600" />
                    <span className="text-ink-400">{r.egressFormat ?? "-"}</span>
                    {r.streaming && <i className="bi bi-broadcast ml-2 text-brand-400" title={t("logs.streamingTitle")} />}
                  </td>
                  <td><StatusBadge status={r.httpStatus} /></td>
                  <td className="text-xs text-ink-300">{formatNumber(r.totalTokens)}</td>
                  <td className="text-xs text-ink-400">{r.latencyMs} {t("common.ms")}</td>
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
            <i className="bi bi-chevron-left" />{t("logs.pagination.prev")}
          </button>
          <span>{t("logs.pagination.summary", { start: offset + 1, end: Math.min(offset + PAGE, total), total: formatNumber(total) })}</span>
          <button className="btn-ghost btn-xs" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            {t("logs.pagination.next")}<i className="bi bi-chevron-right" />
          </button>
        </div>
      )}

      <Modal
        open={detail !== null}
        wide
        title={t("logs.modal.detailTitle", { id: detail?.id ?? "" })}
        icon="bi-journal-text"
        onClose={() => setDetail(null)}
        headerExtra={<PayloadViewToggle view={payloadView} onChange={setPayloadView} />}
      >
        {detail && (
          <div className="space-y-4">
            {detail.error && <ErrorNote message={detail.error} />}
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Meta label={t("logs.meta.service")} value={detail.serviceName ?? "-"} />
              <Meta label={t("logs.meta.status")} value={String(detail.httpStatus)} />
              <Meta label={t("logs.meta.latency")} value={`${detail.latencyMs} ${t("common.ms")}`} />
              <Meta label={t("logs.meta.route")} value={`${detail.ingressFormat} -> ${detail.egressFormat ?? "-"}`} />
              <Meta label={t("logs.meta.streaming")} value={detail.streaming ? t("common.yes") : t("common.no")} />
              <Meta label={t("logs.meta.tokens")} value={`${detail.promptTokens} + ${detail.completionTokens} = ${detail.totalTokens}`} />
              <Meta label={t("logs.meta.servedModel")} value={detail.servedModel ?? "-"} />
              <Meta label={t("logs.meta.servedProvider")} value={detail.servedProvider ?? "-"} />
              <Meta label={t("logs.meta.trace")} value={detail.traceId ?? "-"} />
            </div>

            <HttpInfoBlock
              title={t("logs.http.clientRequest")}
              method={detail.requestMethod}
              path={detail.requestPath}
              query={detail.requestQuery}
              headers={detail.requestHeaders}
            />
            <HttpInfoBlock
              title={t("logs.http.upstreamResponse")}
              status={detail.httpStatus}
              headers={detail.responseHeaders}
            />

            {isCallLog(detail.attemptPath) ? (
              <div>
                <h4 className="label">
                  {t("logs.section.serviceCalls")}
                  <span className="ml-2 normal-case text-ink-500">{t("logs.section.serviceCallsHint")}</span>
                </h4>
                <CallList calls={detail.attemptPath} view={payloadView} />
              </div>
            ) : (
              <div>
                <h4 className="label">
                  {t("logs.section.attemptPath")}
                  {legacyPath(detail.attemptPath).some((a) => a.request || a.response) && (
                    <span className="ml-2 normal-case text-ink-500">{t("logs.section.attemptPathHint")}</span>
                  )}
                </h4>
                <AttemptPathTable
                  path={legacyPath(detail.attemptPath)}
                  view={payloadView}
                  expanded={expandedRows}
                  onToggle={toggleRow}
                />
              </div>
            )}

            <PayloadBlock title={t("logs.payload.clientRequest")} raw={detail.requestPayload} view={payloadView} defaultCollapsed />
            <PayloadBlock title={t("logs.payload.upstreamRequest")} raw={detail.upstreamRequestPayload} view={payloadView} defaultCollapsed />
            <PayloadBlock title={t("logs.payload.response")} raw={detail.responsePayload} view={payloadView} />
          </div>
        )}
      </Modal>
      {confirmEl}
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

function PayloadViewToggle({ view, onChange }: { view: PayloadView; onChange: (v: PayloadView) => void }) {
  const { t } = useI18n();
  const labels: Record<PayloadView, string> = {
    formatted: t("logs.payloadView.formatted"),
    json: t("logs.payloadView.json"),
  };
  return (
    <div className="inline-flex rounded-lg border border-ink-700 p-0.5 text-xs">
      {(["formatted", "json"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 font-medium capitalize transition-colors ${
            view === v ? "bg-brand-600 text-white" : "text-ink-400 hover:text-ink-200"
          }`}
        >
          {labels[v]}
        </button>
      ))}
    </div>
  );
}

function legacyPath(path: unknown): AttemptRecord[] {
  return Array.isArray(path) ? (path as AttemptRecord[]) : [];
}

function callStatusBadge(call: ServiceCallEntry) {
  const { t } = useI18n();
  if (call.kind === "router") return <span className="badge-gray">{t("logs.badge.route")}</span>;
  const ok = call.status >= 200 && call.status < 300;
  return <StatusBadge status={call.status} label={ok ? t("logs.badge.ok") : undefined} />;
}

function callKindIcon(kind: ServiceCallEntry["kind"]): string {
  switch (kind) {
    case "agent":
      return "bi-robot";
    case "router":
      return "bi-signpost-split";
    default:
      return "bi-diagram-3";
  }
}

function CallList({ calls, view }: { calls: ServiceCallEntry[]; view: PayloadView }) {
  return (
    <div className="space-y-2">
      {calls.map((c, i) => (
        <CallItem key={i} call={c} view={view} />
      ))}
    </div>
  );
}

/** One Model Service call: a header row expandable into the service's own
 * attempt path, request/response payloads and (for a nested Micro Agent) the
 * calls it made in turn. */
function CallItem({ call, view }: { call: ServiceCallEntry; view: PayloadView }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const expandable =
    call.attempts.length > 0 || Boolean(call.request) || Boolean(call.response) || (call.calls?.length ?? 0) > 0;
  return (
    <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40">
      <div
        className={`flex items-center gap-2 px-3 py-2 ${expandable ? "cursor-pointer hover:bg-ink-850/50" : ""}`}
        onClick={() => expandable && setOpen(!open)}
      >
        <i
          className={`bi ${expandable ? (open ? "bi-chevron-down" : "bi-chevron-right") : "bi-dot"} text-ink-500`}
        />
        <span className="font-mono text-xs text-brand-400">{call.stage}</span>
        <span className="flex items-center gap-1.5 font-mono text-xs text-ink-300">
          <i className={`bi ${callKindIcon(call.kind)} text-ink-500`} />
          {call.kind === "router" ? t("logs.router.noModelCall") : call.service}
        </span>
        {call.streamed && <i className="bi bi-broadcast text-brand-400" title={t("logs.streamedTitle")} />}
        <div className="flex-1" />
        {call.usage && <span className="text-xs text-ink-400">{formatNumber(call.usage.totalTokens)} {t("common.tok")}</span>}
        {call.kind !== "router" && <span className="text-xs text-ink-400">{call.latencyMs} {t("common.ms")}</span>}
        {callStatusBadge(call)}
      </div>
      {open && expandable && (
        <div className="space-y-3 border-t border-ink-800/70 bg-ink-950/40 p-3">
          {call.error && <ErrorNote message={call.error} />}
          {call.attempts.length > 0 && (
            <div>
              <h4 className="label">{t("logs.section.attemptPath")}</h4>
              <AttemptsTable attempts={call.attempts} />
            </div>
          )}
          <PayloadBlock title={t("logs.payload.request")} raw={call.request ?? null} view={view} defaultCollapsed />
          <PayloadBlock title={t("logs.payload.responseShort")} raw={call.response ?? null} view={view} />
          {(call.calls?.length ?? 0) > 0 && (
            <div>
              <h4 className="label">{t("logs.section.serviceCallsNested")}</h4>
              <CallList calls={call.calls!} view={view} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AttemptsTable({ attempts }: { attempts: AttemptRecord[] }) {
  const { t } = useI18n();
  return (
    <div className="card overflow-hidden">
      <table className="table">
        <thead>
          <tr>
            <th>{t("logs.attemptsTable.step")}</th><th>{t("logs.attemptsTable.try")}</th><th>{t("logs.attemptsTable.model")}</th><th>{t("logs.attemptsTable.provider")}</th><th>{t("logs.attemptsTable.result")}</th><th>{t("logs.attemptsTable.latency")}</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a, i) => (
            <tr key={i}>
              <td>{a.step}</td>
              <td>{a.attempt}</td>
              <td className="font-mono text-xs">{a.model}</td>
              <td className="font-mono text-xs">{a.provider}</td>
              <td>{attemptBadge(a)}</td>
              <td className="text-xs text-ink-400">{a.latencyMs} {t("common.ms")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttemptPathTable({
  path,
  view,
  expanded,
  onToggle,
}: {
  path: AttemptRecord[];
  view: PayloadView;
  expanded: Set<number>;
  onToggle: (i: number) => void;
}) {
  const hasStage = path.some((a) => a.stage);
  const hasService = path.some((a) => a.service);
  const cols = 6 + (hasStage ? 1 : 0) + (hasService ? 1 : 0);
  const { t } = useI18n();
  return (
    <div className="card overflow-hidden">
      <table className="table">
        <thead>
          <tr>
            {hasStage && <th>{t("logs.pathTable.stage")}</th>}
            {hasService && <th>{t("logs.pathTable.service")}</th>}
            <th>{t("logs.attemptsTable.step")}</th><th>{t("logs.attemptsTable.try")}</th><th>{t("logs.attemptsTable.model")}</th><th>{t("logs.attemptsTable.provider")}</th><th>{t("logs.attemptsTable.result")}</th><th>{t("logs.attemptsTable.latency")}</th>
          </tr>
        </thead>
        <tbody>
          {path.map((a, i) => {
            const canExpand = Boolean(a.request || a.response);
            const isOpen = expanded.has(i);
            return (
              <Fragment key={i}>
                <tr
                  className={canExpand ? "cursor-pointer hover:bg-ink-850/50" : ""}
                  onClick={() => canExpand && onToggle(i)}
                >
                  {hasStage && (
                    <td className="font-mono text-xs text-brand-400">
                      {canExpand && <i className={`bi ${isOpen ? "bi-chevron-down" : "bi-chevron-right"} mr-1 text-ink-500`} />}
                      {a.stage ?? "-"}
                    </td>
                  )}
                  {hasService && <td className="font-mono text-xs text-ink-300">{a.service ?? "-"}</td>}
                  <td>{a.step}</td>
                  <td>{a.attempt}</td>
                  <td className="font-mono text-xs">{a.model}</td>
                  <td className="font-mono text-xs">{a.provider}</td>
                  <td>{attemptBadge(a)}</td>
                  <td className="text-xs text-ink-400">{a.latencyMs} {t("common.ms")}</td>
                </tr>
                {isOpen && canExpand && (
                  <tr>
                    <td colSpan={cols} className="bg-ink-950/40 p-3">
                      <div className="space-y-3">
                        <PayloadBlock title={t("logs.payload.stageRequest", { stage: a.stage ?? "" })} raw={a.request ?? null} view={view} defaultCollapsed />
                        <PayloadBlock title={t("logs.payload.stageResponse", { stage: a.stage ?? "" })} raw={a.response ?? null} view={view} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function roleBadge(role: string): string {
  switch (role) {
    case "user":
      return "badge-blue";
    case "assistant":
      return "badge-green";
    case "thinking":
      return "badge-purple";
    default:
      return "badge-gray";
  }
}

function Transcript({ data }: { data: PayloadMeta }) {
  const { t } = useI18n();
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
            {data.tools.length} {data.tools.length === 1 ? t("logs.transcript.tools") : t("logs.transcript.toolsPlural")}
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {data.tools.map((t) => (
              <span key={t} className="badge-gray font-mono">{t}</span>
            ))}
          </div>
        </details>
      )}
      <div className="space-y-2">
        {data.turns.map((turn, i) => (
          <div key={i} className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40">
            <div className="flex items-center gap-2 border-b border-ink-800/70 px-3 py-1.5">
              <span className={roleBadge(turn.role)}>{turn.role}</span>
              <span className="text-[11px] text-ink-600">{turn.text.length.toLocaleString()} {t("common.chars")}</span>
            </div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-ink-200">{turn.text || t("logs.transcript.empty")}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function HttpInfoBlock({
  title,
  method,
  path,
  query,
  status,
  headers,
}: {
  title: string;
  method?: string | null;
  path?: string | null;
  query?: string | null;
  status?: number;
  headers?: Record<string, string> | null;
}) {
  const { t } = useI18n();
  const hasAny = Boolean(method || path || query || status || (headers && Object.keys(headers).length > 0));
  if (!hasAny) {
    return (
      <div>
        <h4 className="label">{title}</h4>
        <div className="rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-500">{t("logs.notRecorded")}</div>
      </div>
    );
  }
  return (
    <div>
      <h4 className="label">{title}</h4>
      <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40">
        {(method || path || status) && (
          <div className="flex items-center gap-2 border-b border-ink-800/70 px-3 py-1.5 font-mono text-xs">
            {status != null && <StatusBadge status={status} />}
            {method && <span className="text-brand-400">{method}</span>}
            {path && <span className="text-ink-200">{path}{query ? `?${query}` : ""}</span>}
          </div>
        )}
        {headers && Object.keys(headers).length > 0 && (
          <table className="w-full text-xs">
            <tbody>
              {Object.entries(headers).map(([k, v]) => (
                <tr key={k} className="border-b border-ink-800/40 last:border-0">
                  <td className="whitespace-nowrap px-3 py-1 align-top font-mono text-ink-400">{k}</td>
                  <td className="break-all px-3 py-1 font-mono text-ink-300">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PayloadBlock({ title, raw, view, defaultCollapsed = false }: { title: string; raw: string | null; view: PayloadView; defaultCollapsed?: boolean }) {
  const { t } = useI18n();
  const parsed = useMemo(() => parsePayload(raw), [raw]);
  const showFormatted = view === "formatted" && parsed;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <i className={`bi ${collapsed ? "bi-chevron-right" : "bi-chevron-down"} text-ink-500`} />
        <h4 className="label m-0 cursor-pointer select-none">{title}</h4>
      </button>
      {!collapsed && (
        raw == null ? (
          <div className="mt-2 rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-500">{t("logs.notRecorded")}</div>
        ) : showFormatted ? (
          <div className="mt-2"><Transcript data={parsed} /></div>
        ) : (
          <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs leading-relaxed text-ink-300">{pretty(raw)}</pre>
        )
      )}
    </div>
  );
}
