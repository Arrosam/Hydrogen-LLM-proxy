import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import { useAsync } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner } from "../components/common";
import { useToast } from "../components/Toast";
import { copyToClipboard } from "../lib/clipboard";
import { formatCompact, formatNumber } from "../lib/format";
import type { GroupCount, StatsSummary, TimePoint } from "../types";

interface OverviewData {
  summary: StatsSummary;
  points: TimePoint[];
  services: GroupCount[];
  models: GroupCount[];
  providers: GroupCount[];
  /** The model/provider breakdown covered only the most recent N requests. */
  modelsCapped: boolean;
}

function EndpointsCard() {
  const toast = useToast();
  const { t } = useI18n();
  const origin = window.location.origin;
  const rows = [
    {
      label: t("overview.endpoints.openaiBaseUrl"),
      value: `${origin}/v1`,
      hint: t("overview.endpoints.openaiBaseUrlHint"),
    },
    {
      label: t("overview.endpoints.openaiResponses"),
      value: `${origin}/v1/responses`,
      hint: t("overview.endpoints.openaiResponsesHint"),
    },
    { label: t("overview.endpoints.anthropicBaseUrl"), value: origin, hint: t("overview.endpoints.anthropicBaseUrlHint") },
  ];
  const copy = async (v: string) => {
    const ok = await copyToClipboard(v);
    if (ok) toast.success(t("overview.endpoints.copiedToClipboard"));
    else toast.error(t("overview.endpoints.copyFailed"));
  };
  return (
    <div className="card card-pad">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-200">
        <i className="bi bi-link-45deg text-brand-400" />
        {t("overview.endpoints.title")}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
            <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-500">{r.label}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-ink-950 px-2 py-1 font-mono text-xs text-brand-400">
                {r.value}
              </code>
              <button className="btn-ghost btn-xs shrink-0" onClick={() => copy(r.value)} title={t("overview.endpoints.copyButton")}>
                <i className="bi bi-clipboard" />
              </button>
            </div>
            <div className="mt-1.5 text-[11px] text-ink-500">{r.hint}{t("overview.endpoints.useModelServiceHint")}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, tone }: { icon: string; label: string; value: string; tone: string }) {
  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</span>
        <i className={`bi ${icon} ${tone}`} />
      </div>
      <div className="mt-2 text-2xl font-semibold text-ink-100">{value}</div>
    </div>
  );
}

function TopList({ title, icon, groups }: { title: string; icon: string; groups: GroupCount[] }) {
  const { t } = useI18n();
  const max = Math.max(1, ...groups.map((g) => g.requests));
  return (
    <div className="card card-pad">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-200">
        <i className={`bi ${icon} text-brand-400`} />
        {title}
      </h3>
      {groups.length === 0 ? (
        <p className="py-4 text-center text-xs text-ink-500">{t("overview.topList.empty")}</p>
      ) : (
        <ul className="space-y-2.5">
          {groups.slice(0, 6).map((g) => (
            <li key={g.key}>
              <div className="mb-1 flex justify-between text-xs">
                <span className="truncate text-ink-200">{g.key}</span>
                <span className="text-ink-500">{formatNumber(g.requests)} {t("overview.topList.reqUnit")}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
                <div className="h-full rounded-full bg-brand-600" style={{ width: `${(g.requests / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Overview() {
  const { t } = useI18n();
  const { data, loading, error } = useAsync<OverviewData>(async () => {
    const [summary, ts, svc, mp] = await Promise.all([
      api.get<StatsSummary>("/stats/summary"),
      api.get<{ points: TimePoint[] }>("/stats/timeseries"),
      api.get<{ groups: GroupCount[] }>("/stats/by-service"),
      api.get<{ models: GroupCount[]; providers: GroupCount[]; capped?: boolean }>("/stats/by-model-provider"),
    ]);
    return { summary, points: ts.points, services: svc.groups, models: mp.models, providers: mp.providers, modelsCapped: mp.capped ?? false };
  });

  return (
    <div>
      <PageHeader title={t("overview.page.title")} subtitle={t("overview.page.subtitle")} icon="bi-speedometer2" />
      <div className="mb-6">
        <EndpointsCard />
      </div>
      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard icon="bi-arrow-left-right" tone="text-brand-400" label={t("overview.stats.requests")} value={formatNumber(data.summary.requests)} />
            <StatCard icon="bi-coin" tone="text-amber-400" label={t("overview.stats.totalTokens")} value={formatCompact(data.summary.totalTokens)} />
            <StatCard icon="bi-exclamation-triangle" tone="text-red-400" label={t("overview.stats.errors")} value={formatNumber(data.summary.errors)} />
            <StatCard icon="bi-stopwatch" tone="text-emerald-400" label={t("overview.stats.avgLatency")} value={`${formatNumber(data.summary.avgLatencyMs)} ms`} />
          </div>

          <div className="card card-pad">
            <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink-200">
              <i className="bi bi-graph-up text-brand-400" />
              {t("overview.chart.title")}
            </h3>
            {data.points.length === 0 ? (
              <EmptyState icon="bi-bar-chart-line" title={t("overview.empty.noRequestsTitle")} hint={t("overview.empty.noRequestsHint")} />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={data.points} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  <defs>
                    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0891b2" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#0891b2" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1b222d" />
                  <XAxis dataKey="day" stroke="#5b6b80" fontSize={11} tickLine={false} />
                  <YAxis stroke="#5b6b80" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: "#151b24", border: "1px solid #273140", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#aab6c6" }}
                  />
                  <Area type="monotone" dataKey="requests" stroke="#22d3ee" strokeWidth={2} fill="url(#g)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <TopList title={t("overview.topList.topServices")} icon="bi-diagram-3" groups={data.services} />
            <TopList title={t("overview.topList.topModels")} icon="bi-box" groups={data.models} />
            <TopList title={t("overview.topList.topProviders")} icon="bi-hdd-network" groups={data.providers} />
          </div>
          {data.modelsCapped && (
            <p className="flex items-center gap-1.5 text-xs text-ink-500">
              <i className="bi bi-info-circle" />
              {t("overview.modelsCappedNote")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
