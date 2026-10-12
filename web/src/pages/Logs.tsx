import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { Button, Icon } from "../components/Button";
import { CodeBlock, MutedBox } from "../components/CodeBlock";
import { EmptyState, ErrorNote, StatusBadge, useConfirm } from "../components/common";
import { DataTable, type Column } from "../components/DataTable";
import { Chevron, DisclosureHeading } from "../components/Disclosure";
import { FilterBar, LiveToggle, Pagination, RefreshButton } from "../components/FilterBar";
import { HttpInfoBlock } from "../components/HttpInfoBlock";
import { CheckboxLabel, Select, type SelectOption } from "../components/inputs";
import { MetaGrid, MetaTile } from "../components/Meta";
import { Modal } from "../components/Modal";
import { AsyncStatus, PageHeader } from "../components/Page";
import { useToast } from "../components/Toast";
import { SegmentedControl } from "../components/Chip";
import { useIsAdmin } from "../auth";
import { nameById } from "../lib/collections";
import { API } from "../lib/endpoints";
import { errorMessage } from "../lib/errors";
import { useAction } from "../lib/hooks";
import { HTTP_OK, isSuccessStatus } from "../lib/http";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { prettyJson } from "../lib/json";
import { msLabel, tokenLabel } from "../lib/labels";
import { fetchServices, fetchTokens } from "../lib/resources";
import { formatNumber, relativeTime } from "../lib/format";
import { parsePayload, type PayloadMeta } from "../lib/payload";
import { useI18n } from "../lib/i18n";
import { useLiveQuery } from "../lib/useLiveQuery";
import { useToggleSet } from "../lib/useToggleSet";
import type { LogSummary, ModelService, Token } from "../types";

interface AttemptRecord {
  step: number;
  attempt: number;
  model: string;
  provider: string;
  status: number;
  kind: string;
  latencyMs: number;
  /** The proxy's view of the failure ("upstream returned 429"). */
  error?: string;
  /** The provider's own explanation, lifted out of its error body. Absent on
   * logs written before v1.7.4, and on failures that never reached a provider. */
  upstreamError?: string;
  /** The raw upstream error body. */
  errorBody?: string;
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
  usage?: TokenCounts;
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
const PAYLOAD_VIEWS: readonly PayloadView[] = ["formatted", "json"];

/** Rows per page of the log list. */
const LOGS_PAGE_SIZE = 50;
/** Interval of the list's silent auto-refresh. */
const LOGS_REFRESH_MS = 5000;
/** `kind` of an attempt that succeeded. */
const ATTEMPT_OK = "ok";
/** `kind` of a call that only picked a route and reached no model. */
const CALL_ROUTER = "router";
/** Shown where a log has no value for a field. */
const NONE = "-";

/** Badge of each transcript role; anything else is gray. */
const ROLE_BADGE: Record<string, string> = { user: "badge-blue", assistant: "badge-green", thinking: "badge-purple" };

/** Look of a row that opens when clicked. */
const EXPANDABLE_ROW = "cursor-pointer hover:bg-ink-850/50";

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
function AttemptBadge({ a }: { a: AttemptRecord }) {
  const { t } = useI18n();
  if (a.kind === ATTEMPT_OK) return <StatusBadge status={HTTP_OK} label={t("logs.badge.ok")} />;
  return <StatusBadge status={a.status} label={String(a.status || a.kind)} />;
}

/** The four counters a row carries, of which three are subsets of the other. */
interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
}

/**
 * Input and output side by side, each with the share of itself that was
 * something else: how much of the input the cache supplied, and how much of the
 * output was thinking rather than answer.
 *
 * Both parentheticals are SUBSETS and never addends (see the convention in
 * core/ir/usage.ts) -- which is exactly why they are written inside the number
 * they belong to rather than in a column of their own, where they read as a
 * total waiting to be summed. The compact form shows the cache HIT only,
 * because that is the number a caching setup is judged on; the tooltip and the
 * detail panel carry the cache write too.
 */
function TokenSplit({ usage }: { usage: TokenCounts }) {
  const { t } = useI18n();
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheCreationInputTokens ?? 0;
  const thinking = usage.reasoningTokens ?? 0;
  const title = t("logs.tokens.title", {
    input: formatNumber(usage.promptTokens),
    cached: formatNumber(cached),
    written: formatNumber(written),
    output: formatNumber(usage.completionTokens),
    thinking: formatNumber(thinking),
  });
  return (
    <span className="whitespace-nowrap text-xs text-ink-300" title={title}>
      {formatNumber(usage.promptTokens)}
      {cached > 0 && <span className="text-ink-500"> ({formatNumber(cached)})</span>}
      <i className="bi bi-arrow-right mx-1 text-ink-600" />
      {formatNumber(usage.completionTokens)}
      {thinking > 0 && <span className="text-ink-500"> ({formatNumber(thinking)})</span>}
    </span>
  );
}

/** The input line for the detail panel: every input token, and what the cache
 * accounted for. */
function inputSummary(u: TokenCounts, t: (k: string, p?: Record<string, string | number>) => string): string {
  const parts: string[] = [];
  if ((u.cachedInputTokens ?? 0) > 0) parts.push(t("logs.tokens.cached", { n: formatNumber(u.cachedInputTokens ?? 0) }));
  if ((u.cacheCreationInputTokens ?? 0) > 0) parts.push(t("logs.tokens.written", { n: formatNumber(u.cacheCreationInputTokens ?? 0) }));
  return parts.length ? `${formatNumber(u.promptTokens)} (${parts.join(" · ")})` : formatNumber(u.promptTokens);
}

/** The output line: every output token, and how much of it was thinking. */
function outputSummary(u: TokenCounts, t: (k: string, p?: Record<string, string | number>) => string): string {
  const thinking = u.reasoningTokens ?? 0;
  return thinking > 0
    ? `${formatNumber(u.completionTokens)} (${t("logs.tokens.thinking", { n: formatNumber(thinking) })})`
    : formatNumber(u.completionTokens);
}

/** Whether an attempt has anything to say about why it failed. */
function hasError(a: AttemptRecord): boolean {
  return Boolean(a.error || a.upstreamError || a.errorBody);
}

/** The single most informative line about a failed attempt: the provider's own
 * words when it gave any, the proxy's otherwise. */
function errorLine(a: AttemptRecord): string {
  return a.upstreamError || a.error || "";
}

/** One titled part of an attempt's failure. */
function ErrorPart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="label m-0">{title}</div>
      {children}
    </div>
  );
}

/**
 * The full failure of one attempt. The provider's message and the proxy's are
 * both shown when they differ -- "upstream returned 400" and "this model does
 * not support tool use" answer different questions, and only the second one
 * tells you what to change.
 */
function AttemptError({ a }: { a: AttemptRecord }) {
  const { t } = useI18n();
  const upstream = a.upstreamError && a.upstreamError !== a.error ? a.upstreamError : null;
  return (
    <div className="space-y-2">
      {upstream && (
        <ErrorPart title={t("logs.error.upstream")}>
          <CodeBlock as="p" className="mt-1" frame="error" padding="sm" tone="error">{upstream}</CodeBlock>
        </ErrorPart>
      )}
      {a.error && (
        <ErrorPart title={t("logs.error.proxy")}>
          <CodeBlock as="p" className="mt-1" padding="sm">{a.error}</CodeBlock>
        </ErrorPart>
      )}
      {a.errorBody && (
        <ErrorPart title={t("logs.error.body")}>
          <CodeBlock className="mt-1" maxHeight="sm" padding="sm" tone="muted" relaxed>{pretty(a.errorBody)}</CodeBlock>
        </ErrorPart>
      )}
    </div>
  );
}

/** A logged payload as text: re-indented when it is JSON, a dash when nothing was logged. */
function pretty(json: string | null): string {
  return json ? prettyJson(json) : NONE;
}

interface LogPage {
  rows: LogSummary[];
  total: number;
}

export function Logs() {
  const [offset, setOffset] = useState(0);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [serviceId, setServiceId] = useState<number | "">("");
  const [services, setServices] = useState<ModelService[]>([]);
  const [tokenId, setTokenId] = useState<number | "">("");
  const [tokens, setTokens] = useState<Token[]>([]);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [payloadView, setPayloadView] = useState<PayloadView>("formatted");
  const toast = useToast();
  const isAdmin = useIsAdmin();
  const { confirm, confirmEl } = useConfirm();
  const clearing = useAction({ describe: errorMessage });
  const { t } = useI18n();

  useEffect(() => {
    fetchServices().then(setServices).catch(() => {});
    // Only used to label and offer the filter; a caller who cannot list keys
    // simply gets the "all keys" option, same as the services fetch above.
    fetchTokens().then(setTokens).catch(() => {});
  }, []);

  const query = useCallback(() => {
    const params = new URLSearchParams({ limit: String(LOGS_PAGE_SIZE), offset: String(offset) });
    if (errorsOnly) params.set("errorsOnly", "true");
    if (serviceId !== "") params.set("serviceId", String(serviceId));
    if (tokenId !== "") params.set("tokenId", String(tokenId));
    return api.get<LogPage>(`${API.logs}?${params.toString()}`);
  }, [offset, errorsOnly, serviceId, tokenId]);
  // Auto-refresh is silent: no spinner flicker.
  const list = useLiveQuery(query, { pollMs: LOGS_REFRESH_MS, live: autoRefresh });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  /** Every filter change starts again from the first page. */
  const filterBy = <V,>(apply: (value: V) => void) => (value: V): void => {
    setOffset(0);
    apply(value);
  };

  const openDetail = async (id: number) => {
    try {
      const r = await api.get<{ log: LogDetail }>(API.log(id));
      setDetail(r.log);
    } catch (e) {
      list.setError(errorMessage(e, t("logs.error.loadDetailFailed")));
    }
  };

  const serviceName = (id: number | null) => (id == null ? NONE : nameById(services, id));

  const clearAll = async () => {
    const ok = await confirm(
      t("logs.confirm.clearAllTitle"),
      t("logs.confirm.clearAllBody", { total: formatNumber(total) }),
    );
    if (!ok) return;
    await clearing.run(async () => {
      const r = await api.del<{ deleted: number }>(API.logs);
      toast.success(t("logs.toast.deleted", { count: formatNumber(r.deleted) }));
      // One request for the first page: from a later page the offset change
      // itself reloads, and reloading here as well would ask for the page just
      // left, whose answer could arrive last and win.
      if (offset === 0) list.reload();
      else setOffset(0);
    }, t("logs.toast.clearFailed"));
  };

  const columns: Column<LogSummary>[] = [
    { header: t("logs.table.time"), className: "whitespace-nowrap text-xs text-ink-400", cell: (r) => relativeTime(r.createdAt) },
    { header: t("logs.table.service"), className: "font-mono text-xs text-ink-200", cell: (r) => r.serviceName ?? serviceName(r.serviceId) },
    {
      header: t("logs.table.route"),
      className: "text-xs",
      cell: (r) => (
        <>
          <span className="text-ink-300">{r.ingressFormat}</span>
          <Icon name="bi-arrow-right" className="mx-1 text-ink-600" />
          <span className="text-ink-400">{r.egressFormat ?? NONE}</span>
          {r.streaming && <i className={`bi ${ACTION_ICON.live} ml-2 text-brand-400`} title={t("logs.streamingTitle")} />}
        </>
      ),
    },
    { header: t("logs.table.status"), cell: (r) => <StatusBadge status={r.httpStatus} /> },
    { header: t("logs.table.tokens"), cell: (r) => <TokenSplit usage={r} /> },
    { header: t("logs.table.latency"), className: "text-xs text-ink-400", cell: (r) => msLabel(r.latencyMs, t) },
    { header: t("logs.table.tries"), className: "text-xs text-ink-400", cell: (r) => r.attempts },
    { className: "text-right", cell: () => <Icon name="bi-chevron-right" className="text-ink-600" /> },
  ];

  return (
    <div>
      <PageHeader title={t("logs.title")} subtitle={t("logs.subtitle")} icon={ENTITY_ICON.log} />

      <FilterBar
        count={<>{formatNumber(total)} {t("logs.totalCount")}</>}
        end={
          isAdmin && (
            <Button
              variant="danger"
              size="xs"
              icon={ACTION_ICON.remove}
              busy={clearing.busy}
              spinWhenBusy
              disabled={total === 0}
              onClick={clearAll}
              title={t("logs.action.clearAllTitle")}
            >
              {t("logs.action.clearAll")}
            </Button>
          )
        }
      >
        <IdFilter
          value={serviceId}
          onChange={filterBy(setServiceId)}
          allLabel={t("logs.filter.allServices")}
          options={services.map((m) => ({ value: m.id, label: m.name }))}
        />
        <IdFilter
          value={tokenId}
          onChange={filterBy(setTokenId)}
          allLabel={t("logs.filter.allKeys")}
          options={tokens.map((k) => ({ value: k.id, label: tokenLabel(k) }))}
        />
        <CheckboxLabel checked={errorsOnly} onChange={filterBy(setErrorsOnly)}>
          {t("logs.filter.errorsOnly")}
        </CheckboxLabel>
        <RefreshButton onClick={() => list.reload()}>{t("logs.action.refresh")}</RefreshButton>
        <LiveToggle live={autoRefresh} onChange={setAutoRefresh} label={t("logs.autoRefreshLabel")} badge={t("logs.liveBadge")} />
      </FilterBar>

      <AsyncStatus state={list} />
      {!list.loading && rows.length === 0 && <EmptyState icon={ENTITY_ICON.log} title={t("logs.empty.title")} hint={t("logs.empty.hint")} />}

      {rows.length > 0 && (
        <DataTable rows={rows} rowKey={(r) => r.id} columns={columns} onRowClick={(r) => openDetail(r.id)} rowClassName="cursor-pointer" />
      )}

      <Pagination
        offset={offset}
        pageSize={LOGS_PAGE_SIZE}
        total={total}
        onChange={setOffset}
        labels={{
          prev: t("logs.pagination.prev"),
          next: t("logs.pagination.next"),
          summary: (range) => t("logs.pagination.summary", { ...range, total: formatNumber(total) }),
        }}
      />

      <Modal
        open={detail !== null}
        size="xl"
        title={t("logs.modal.detailTitle", { id: detail?.id ?? "" })}
        icon={ENTITY_ICON.log}
        onClose={() => setDetail(null)}
        headerExtra={<PayloadViewToggle view={payloadView} onChange={setPayloadView} />}
      >
        {detail && <LogDetailBody key={detail.id} detail={detail} view={payloadView} />}
      </Modal>
      {confirmEl}
    </div>
  );
}

/** A filter on a numeric id, with a leading "all" choice (the empty value). */
function IdFilter({
  value,
  onChange,
  allLabel,
  options,
}: {
  value: number | "";
  onChange: (value: number | "") => void;
  allLabel: string;
  options: SelectOption<number>[];
}) {
  // `Select` reports the "all" option as its empty value, typed like an id.
  return <Select className="w-auto" value={value} onChange={(v) => onChange(v || "")} options={options} placeholder={allLabel} />;
}

/** A `label` heading inside the detail view, with an optional lower-case note. */
function SectionTitle({ title, hint }: { title: string; hint?: string | false }) {
  return (
    <h4 className="label">
      {title}
      {hint && <span className="ml-2 normal-case text-ink-500">{hint}</span>}
    </h4>
  );
}

/** Everything the detail modal shows about one log. */
function LogDetailBody({ detail, view }: { detail: LogDetail; view: PayloadView }) {
  const { t } = useI18n();
  const flat = legacyPath(detail.attemptPath);
  return (
    <div className="space-y-4">
      {detail.error && <ErrorNote message={detail.error} />}
      <MetaGrid>
        <MetaTile label={t("logs.meta.service")} value={detail.serviceName ?? NONE} />
        <MetaTile label={t("logs.meta.status")} value={String(detail.httpStatus)} />
        <MetaTile label={t("logs.meta.latency")} value={msLabel(detail.latencyMs, t)} />
        <MetaTile label={t("logs.meta.route")} value={`${detail.ingressFormat} -> ${detail.egressFormat ?? NONE}`} />
        <MetaTile label={t("logs.meta.streaming")} value={detail.streaming ? t("common.yes") : t("common.no")} />
        {/* The cache and thinking shares are written inside the count
            they belong to: each is a subset of it, and a cell of its own
            invites adding them up. */}
        <MetaTile label={t("logs.meta.input")} value={inputSummary(detail, t)} />
        <MetaTile label={t("logs.meta.output")} value={outputSummary(detail, t)} />
        <MetaTile label={t("logs.meta.totalTokens")} value={formatNumber(detail.totalTokens)} />
        <MetaTile label={t("logs.meta.servedModel")} value={detail.servedModel ?? NONE} />
        <MetaTile label={t("logs.meta.servedProvider")} value={detail.servedProvider ?? NONE} />
        <MetaTile label={t("logs.meta.trace")} value={detail.traceId ?? NONE} />
      </MetaGrid>

      <HttpInfoBlock
        title={t("logs.http.clientRequest")}
        method={detail.requestMethod}
        path={detail.requestPath}
        query={detail.requestQuery}
        headers={detail.requestHeaders}
        emptyLabel={t("logs.notRecorded")}
      />
      <HttpInfoBlock
        title={t("logs.http.upstreamResponse")}
        status={detail.httpStatus}
        headers={detail.responseHeaders}
        emptyLabel={t("logs.notRecorded")}
      />

      {isCallLog(detail.attemptPath) ? (
        <div>
          <SectionTitle title={t("logs.section.serviceCalls")} hint={t("logs.section.serviceCallsHint")} />
          <CallList calls={detail.attemptPath} view={view} />
        </div>
      ) : (
        <div>
          <SectionTitle
            title={t("logs.section.attemptPath")}
            hint={flat.some((a) => a.request || a.response) && t("logs.section.attemptPathHint")}
          />
          <AttemptTable attempts={flat} chevron="first" view={view} />
        </div>
      )}

      <PayloadBlock title={t("logs.payload.clientRequest")} raw={detail.requestPayload} view={view} />
      <PayloadBlock title={t("logs.payload.upstreamRequest")} raw={detail.upstreamRequestPayload} view={view} />
      <PayloadBlock title={t("logs.payload.response")} raw={detail.responsePayload} view={view} />
    </div>
  );
}

function PayloadViewToggle({ view, onChange }: { view: PayloadView; onChange: (v: PayloadView) => void }) {
  const { t } = useI18n();
  return (
    <SegmentedControl
      variant="joined"
      value={view}
      onChange={onChange}
      options={PAYLOAD_VIEWS.map((v) => ({ value: v, label: t(`logs.payloadView.${v}`) }))}
    />
  );
}

function legacyPath(path: unknown): AttemptRecord[] {
  return Array.isArray(path) ? (path as AttemptRecord[]) : [];
}

function CallStatusBadge({ call }: { call: ServiceCallEntry }) {
  const { t } = useI18n();
  if (call.kind === CALL_ROUTER) return <span className="badge-gray">{t("logs.badge.route")}</span>;
  const ok = isSuccessStatus(call.status);
  return <StatusBadge status={call.status} label={ok ? t("logs.badge.ok") : undefined} />;
}

function callKindIcon(kind: ServiceCallEntry["kind"]): string {
  switch (kind) {
    case "agent":
      return ENTITY_ICON.microAgent;
    case "router":
      return "bi-signpost-split";
    default:
      return ENTITY_ICON.service;
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
  const nested = call.calls ?? [];
  const expandable = call.attempts.length > 0 || Boolean(call.request) || Boolean(call.response) || nested.length > 0;
  const isRouter = call.kind === CALL_ROUTER;
  return (
    <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40">
      <div
        className={`flex items-center gap-2 px-3 py-2 ${expandable ? EXPANDABLE_ROW : ""}`}
        onClick={() => expandable && setOpen(!open)}
      >
        {expandable ? <Chevron open={open} /> : <Icon name="bi-dot" className="text-ink-500" />}
        <span className="font-mono text-xs text-brand-400">{call.stage}</span>
        <span className="flex items-center gap-1.5 font-mono text-xs text-ink-300">
          <Icon name={callKindIcon(call.kind)} className="text-ink-500" />
          {isRouter ? t("logs.router.noModelCall") : call.service}
        </span>
        {call.streamed && <i className={`bi ${ACTION_ICON.live} text-brand-400`} title={t("logs.streamedTitle")} />}
        <div className="flex-1" />
        {call.usage && <TokenSplit usage={call.usage} />}
        {!isRouter && <span className="text-xs text-ink-400">{msLabel(call.latencyMs, t)}</span>}
        <CallStatusBadge call={call} />
      </div>
      {open && expandable && (
        <div className="space-y-3 border-t border-ink-800/70 bg-ink-950/40 p-3">
          {call.error && <ErrorNote message={call.error} />}
          {call.attempts.length > 0 && (
            <div>
              <SectionTitle title={t("logs.section.attemptPath")} />
              <AttemptTable attempts={call.attempts} chevron="error" />
            </div>
          )}
          <PayloadBlock title={t("logs.payload.request")} raw={call.request ?? null} view={view} />
          <PayloadBlock title={t("logs.payload.responseShort")} raw={call.response ?? null} view={view} />
          {nested.length > 0 && (
            <div>
              <SectionTitle title={t("logs.section.serviceCallsNested")} />
              <CallList calls={nested} view={view} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The attempts behind one answer, one row each, opening into what went wrong.
 *
 * It is drawn in two places that differ on purpose:
 * - under a Model Service call (`chevron="error"`, no `view`): a row opens only
 *   when it failed, into its error; the arrow sits in the error cell.
 * - as a log's own flat path (`chevron="first"`, with `view`): a row also opens
 *   when it recorded a request or response, into the error and both payloads;
 *   the arrow leads the row.
 *
 * The stage, service and error columns exist only when some attempt has one.
 */
function AttemptTable({ attempts, chevron, view }: { attempts: AttemptRecord[]; chevron: "first" | "error"; view?: PayloadView }) {
  const { t } = useI18n();
  const [open, toggle] = useToggleSet<number>();
  const hasStage = attempts.some((a) => a.stage);
  const withPayloads = view !== undefined;
  const hasPayload = (a: AttemptRecord): boolean => withPayloads && Boolean(a.request || a.response);
  const canExpand = (a: AttemptRecord): boolean => hasError(a) || hasPayload(a);
  /** The leading arrow, in whichever column comes first. */
  const lead = (a: AttemptRecord, i: number) =>
    chevron === "first" && canExpand(a) && <Chevron open={open.has(i)} className="mr-1 text-ink-500" />;

  const columns: Column<AttemptRecord>[] = [
    {
      header: t("logs.pathTable.stage"),
      hidden: !hasStage,
      className: "font-mono text-xs text-brand-400",
      cell: (a, i) => <>{lead(a, i)}{a.stage ?? NONE}</>,
    },
    {
      header: t("logs.pathTable.service"),
      hidden: !attempts.some((a) => a.service),
      className: "font-mono text-xs text-ink-300",
      cell: (a) => a.service ?? NONE,
    },
    { header: t("logs.attemptsTable.step"), cell: (a, i) => <>{!hasStage && lead(a, i)}{a.step}</> },
    { header: t("logs.attemptsTable.try"), cell: (a) => a.attempt },
    { header: t("logs.attemptsTable.model"), className: "font-mono text-xs", cell: (a) => a.model },
    { header: t("logs.attemptsTable.provider"), className: "font-mono text-xs", cell: (a) => a.provider },
    { header: t("logs.attemptsTable.result"), cell: (a) => <AttemptBadge a={a} /> },
    { header: t("logs.attemptsTable.latency"), className: "text-xs text-ink-400", cell: (a) => msLabel(a.latencyMs, t) },
    {
      header: t("logs.attemptsTable.error"),
      hidden: !attempts.some(hasError),
      className: "max-w-md",
      cell: (a, i) =>
        hasError(a) && (
          <span className={`${chevron === "error" ? "flex items-start gap-1 " : ""}text-xs text-red-300`} title={errorLine(a)}>
            {chevron === "error" && <Chevron open={open.has(i)} className="mt-0.5 text-ink-500" />}
            <span className="line-clamp-2 break-words">{errorLine(a)}</span>
          </span>
        ),
    },
  ];

  const detail = (a: AttemptRecord, i: number) => {
    if (!open.has(i) || !canExpand(a)) return null;
    if (!withPayloads) return <AttemptError a={a} />;
    return (
      <div className="space-y-3">
        {hasError(a) && <AttemptError a={a} />}
        {hasPayload(a) && (
          <>
            <PayloadBlock title={t("logs.payload.stageRequest", { stage: a.stage ?? "" })} raw={a.request ?? null} view={view} />
            <PayloadBlock title={t("logs.payload.stageResponse", { stage: a.stage ?? "" })} raw={a.response ?? null} view={view} />
          </>
        )}
      </div>
    );
  };

  return (
    <DataTable
      rows={attempts}
      rowKey={(_, i) => i}
      columns={columns}
      onRowClick={(a, i) => canExpand(a) && toggle(i)}
      rowClassName={(a) => (canExpand(a) ? EXPANDABLE_ROW : "")}
      expanded={detail}
      expandedClassName="bg-ink-950/40 p-3"
    />
  );
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
            <Icon name={ENTITY_ICON.tool} className="mr-1 text-ink-500" />
            {data.tools.length} {data.tools.length === 1 ? t("logs.transcript.tools") : t("logs.transcript.toolsPlural")}
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {data.tools.map((tool) => (
              <span key={tool} className="badge-gray font-mono">{tool}</span>
            ))}
          </div>
        </details>
      )}
      <div className="space-y-2">
        {data.turns.map((turn, i) => (
          <div key={i} className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40">
            <div className="flex items-center gap-2 border-b border-ink-800/70 px-3 py-1.5">
              <span className={ROLE_BADGE[turn.role] ?? "badge-gray"}>{turn.role}</span>
              <span className="text-[11px] text-ink-600">{formatNumber(turn.text.length)} {t("common.chars")}</span>
            </div>
            <CodeBlock maxHeight="lg" frame="none" padding="row" tone="strong" relaxed>{turn.text || t("logs.transcript.empty")}</CodeBlock>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A payload with its own collapse toggle. Opens expanded: a payload you have to
 * go looking for reads as a payload that wasn't recorded. */
function PayloadBlock({ title, raw, view }: { title: string; raw: string | null; view: PayloadView }) {
  const { t } = useI18n();
  const parsed = useMemo(() => parsePayload(raw), [raw]);
  const [open, setOpen] = useState(true);
  return (
    <div>
      <DisclosureHeading open={open} onToggle={() => setOpen((o) => !o)} title={title} fullWidth announce />
      {open &&
        (raw == null ? (
          <MutedBox className="mt-2">{t("logs.notRecorded")}</MutedBox>
        ) : view === "formatted" && parsed ? (
          <div className="mt-2"><Transcript data={parsed} /></div>
        ) : (
          <CodeBlock className="mt-2" maxHeight="screen" relaxed>{pretty(raw)}</CodeBlock>
        ))}
    </div>
  );
}
