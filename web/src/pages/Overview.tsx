import { useState } from "react";
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
import { useAsync, useCopy } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import { Bar } from "../components/Bar";
import { Button, Icon } from "../components/Button";
import { EmptyState } from "../components/common";
import { AsyncStatus, PageHeader } from "../components/Page";
import { CardHeading } from "../components/Section";
import { formatCompact, formatNumber } from "../lib/format";
import { PERCENT } from "../lib/constants";
import { API } from "../lib/endpoints";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { INK, METRIC_TONE } from "../lib/theme";
import type { GroupCount, StatsSummary, TimePoint } from "../types";

/** Between an endpoint's own hint and the note every endpoint shares. */
const HINT_SEPARATOR = " · ";

/** Rows a "top ..." card shows. */
const TOP_LIST_LIMIT = 6;

/** Geometry of the traffic chart. */
const CHART = {
  height: 260,
  margin: { top: 4, right: 8, bottom: 0 },
  /** A hidden axis takes no width: pull the plot over when none is labelled,
   * give the ticks room when one is. */
  leftMargin: { labelled: 4, bare: -12 },
  gridDash: "3 3",
  tickFontSize: 11,
  tooltipFontSize: 12,
  tooltipRadius: 8,
  strokeWidth: 2,
  /** Opacity at the top of a filled curve's gradient (it fades to 0). */
  gradientTopOpacity: 0.5,
  /** A legend dot whose series is not the focused one. */
  dimmedOpacity: 0.3,
} as const;

type SeriesKey = "requests" | "totalTokens" | "errors" | "avgLatencyMs";

/** A latency as the page writes it. */
const formatLatency = (ms: number): string => `${formatNumber(ms)} ms`;

/** The cached share as a percentage of prompt tokens. Cached tokens are counted
 * INSIDE promptTokens, so this is a ratio, never a second addend. */
function cacheHitHint(s: StatsSummary): string | undefined {
  if (!s.promptTokens) return undefined;
  return `${Math.round((s.cachedInputTokens / s.promptTokens) * PERCENT)}% of input`;
}

/**
 * The numbers of the page, in stat-card order. Each is one card; the ones
 * with a `series` are also a curve of the traffic chart, drawn in the colour
 * of the card's icon and formatted the same way -- one metric, one colour,
 * whether you read it as a number or as a shape.
 */
interface Metric {
  key: "requests" | "totalTokens" | "cachedInputTokens" | "errors" | "avgLatencyMs";
  icon: string;
  /** The metric's colour: its card icon's, and its curve's when it has one. */
  tone: keyof typeof METRIC_TONE;
  /** i18n key of the card's caption. */
  label: string;
  format: (n: number) => string;
  hint?: (s: StatsSummary) => string | undefined;
  series?: { key: SeriesKey; label: string };
}

const METRICS: readonly Metric[] = [
  {
    key: "requests",
    icon: "bi-arrow-left-right",
    tone: "brand",
    label: "overview.stats.requests",
    format: formatNumber,
    series: { key: "requests", label: "overview.chart.series.requests" },
  },
  {
    key: "totalTokens",
    icon: "bi-coin",
    tone: "amber",
    label: "overview.stats.totalTokens",
    format: formatCompact,
    series: { key: "totalTokens", label: "overview.chart.series.tokens" },
  },
  // The cached share of the prompt tokens -- what a prompt-caching setup is
  // actually judged on, and billed at a fraction of a miss.
  {
    key: "cachedInputTokens",
    icon: "bi-database-check",
    tone: "sky",
    label: "overview.stats.cachedTokens",
    format: formatCompact,
    hint: cacheHitHint,
  },
  {
    key: "errors",
    icon: "bi-exclamation-triangle",
    tone: "red",
    label: "overview.stats.errors",
    format: formatNumber,
    series: { key: "errors", label: "overview.chart.series.errors" },
  },
  {
    key: "avgLatencyMs",
    icon: "bi-stopwatch",
    tone: "emerald",
    label: "overview.stats.avgLatency",
    format: formatLatency,
    series: { key: "avgLatencyMs", label: "overview.chart.series.latency" },
  },
];

/** The three rankings under the chart: which list of the loaded data, under which title and icon. */
const TOP_LISTS = [
  { groups: "services", title: "overview.topList.topServices", icon: ENTITY_ICON.service },
  { groups: "models", title: "overview.topList.topModels", icon: ENTITY_ICON.model },
  { groups: "providers", title: "overview.topList.topProviders", icon: ENTITY_ICON.provider },
] as const;

interface OverviewData {
  summary: StatsSummary;
  points: TimePoint[];
  services: GroupCount[];
  models: GroupCount[];
  providers: GroupCount[];
}

function EndpointsCard() {
  const { t } = useI18n();
  const copy = useCopy({ ok: t("overview.endpoints.copiedToClipboard"), fail: t("overview.endpoints.copyFailed") });
  const origin = window.location.origin;
  const rows = [
    // One row per SDK base URL. The Responses endpoint hangs off the same
    // OpenAI base URL, so it is a note on that row rather than a row of its own.
    {
      label: t("overview.endpoints.openaiBaseUrl"),
      value: `${origin}/v1`,
      hint: t("overview.endpoints.openaiBaseUrlHint"),
    },
    { label: t("overview.endpoints.anthropicBaseUrl"), value: origin, hint: t("overview.endpoints.anthropicBaseUrlHint") },
  ];
  return (
    <div className="card card-pad">
      <CardHeading icon="bi-link-45deg" className="mb-3">
        {t("overview.endpoints.title")}
      </CardHeading>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
            <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-500">{r.label}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-ink-950 px-2 py-1 font-mono text-xs text-brand-400">
                {r.value}
              </code>
              <Button variant="ghost" size="xs" className="shrink-0" icon={ACTION_ICON.copy} onClick={() => void copy(r.value)} title={t("overview.endpoints.copyButton")} />
            </div>
            <div className="mt-1.5 text-[11px] text-ink-500">{r.hint}{HINT_SEPARATOR}{t("overview.endpoints.useModelServiceHint")}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, tone, hint }: { icon: string; label: string; value: string; tone: string; hint?: string }) {
  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</span>
        <Icon name={icon} className={tone} />
      </div>
      <div className="mt-2 text-2xl font-semibold text-ink-100">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-500">{hint}</div>}
    </div>
  );
}

function TopList({ title, icon, groups }: { title: string; icon: string; groups: GroupCount[] }) {
  const { t } = useI18n();
  const max = Math.max(1, ...groups.map((g) => g.requests));
  return (
    <div className="card card-pad">
      <CardHeading icon={icon} className="mb-3">
        {title}
      </CardHeading>
      {groups.length === 0 ? (
        <p className="py-4 text-center text-xs text-ink-500">{t("overview.topList.empty")}</p>
      ) : (
        <ul className="space-y-2.5">
          {groups.slice(0, TOP_LIST_LIMIT).map((g) => (
            <li key={g.key}>
              <div className="mb-1 flex justify-between text-xs">
                <span className="truncate text-ink-200">{g.key}</span>
                <span className="text-ink-500">{formatNumber(g.requests)} {t("overview.topList.reqUnit")}</span>
              </div>
              <Bar percent={(g.requests / max) * PERCENT} tone="bg-brand-600" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The four metrics share an X axis and nothing else: requests are tens, tokens
 * are hundreds of thousands, latency is hundreds of milliseconds and errors are
 * single digits. On one Y axis three of them are a flat line on zero, so each
 * gets its own -- drawn together they compare *shape*, which is what a traffic
 * chart is read for.
 *
 * Absolute values then need somewhere to live, so clicking a legend entry locks
 * the chart to that metric alone and reveals its axis with real numbers. Click
 * it again to go back to all four.
 */
function TrafficChart({ points }: { points: TimePoint[] }) {
  const { t } = useI18n();
  const [locked, setLocked] = useState<SeriesKey | null>(null);

  const series = METRICS.flatMap((m) =>
    m.series ? [{ ...m.series, color: METRIC_TONE[m.tone].color, label: t(m.series.label), format: m.format }] : [],
  );
  const shown = locked ? series.filter((x) => x.key === locked) : series;

  return (
    <div className="card card-pad">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <CardHeading icon="bi-graph-up">{t("overview.chart.title")}</CardHeading>
        <div className="flex flex-wrap items-center gap-1">
          {series.map((x) => {
            const focused = locked === x.key;
            const dimmed = locked !== null && !focused;
            return (
              <button
                key={x.key}
                type="button"
                title={t("overview.chart.focusHint")}
                aria-pressed={focused}
                onClick={() => setLocked(focused ? null : x.key)}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition ${
                  focused
                    ? "bg-ink-800 font-medium text-ink-100"
                    : "text-ink-400 hover:bg-ink-800/60 hover:text-ink-200"
                }`}
              >
                <span
                  className="h-2 w-2 rounded-full transition-opacity"
                  style={{ background: x.color, opacity: dimmed ? CHART.dimmedOpacity : 1 }}
                />
                {x.label}
              </button>
            );
          })}
        </div>
      </div>
      {points.length === 0 ? (
        <EmptyState icon="bi-bar-chart-line" title={t("overview.empty.noRequestsTitle")} hint={t("overview.empty.noRequestsHint")} />
      ) : (
        <ResponsiveContainer width="100%" height={CHART.height}>
          {/* left margin: a hidden axis takes no width, so pull the plot over
              when none is labelled and give the ticks room when one is. */}
          <AreaChart data={points} margin={{ ...CHART.margin, left: locked ? CHART.leftMargin.labelled : CHART.leftMargin.bare }}>
            <defs>
              {series.map((x) => (
                <linearGradient key={x.key} id={`grad-${x.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={x.color} stopOpacity={CHART.gradientTopOpacity} />
                  <stop offset="100%" stopColor={x.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray={CHART.gridDash} stroke={INK[800]} />
            <XAxis dataKey="day" stroke={INK[500]} fontSize={CHART.tickFontSize} tickLine={false} />
            {series.map((x) => (
              <YAxis
                key={x.key}
                yAxisId={x.key}
                hide={locked !== x.key}
                stroke={x.color}
                fontSize={CHART.tickFontSize}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                tickFormatter={(v: number) => x.format(v)}
              />
            ))}
            <Tooltip
              contentStyle={{ background: INK[850], border: `1px solid ${INK[700]}`, borderRadius: CHART.tooltipRadius, fontSize: CHART.tooltipFontSize }}
              labelStyle={{ color: INK[300] }}
              formatter={(value: number | string, name: string) => {
                const x = series.find((c) => c.label === name);
                return [x ? x.format(Number(value)) : String(value), name];
              }}
            />
            {shown.map((x) => (
              <Area
                key={x.key}
                yAxisId={x.key}
                name={x.label}
                type="monotone"
                dataKey={x.key}
                stroke={x.color}
                strokeWidth={CHART.strokeWidth}
                // Filled only when it is the single curve on screen: four
                // translucent areas stacked on top of each other read as mud.
                fill={locked === x.key ? `url(#grad-${x.key})` : "none"}
                fillOpacity={locked === x.key ? 1 : 0}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export function Overview() {
  const { t } = useI18n();
  const state = useAsync<OverviewData>(async () => {
    const [summary, ts, svc, mp] = await Promise.all([
      api.get<StatsSummary>(API.statsSummary),
      api.get<{ points: TimePoint[] }>(API.statsTimeseries),
      api.get<{ groups: GroupCount[] }>(API.statsByService),
      api.get<{ models: GroupCount[]; providers: GroupCount[] }>(API.statsByModelProvider),
    ]);
    return { summary, points: ts.points, services: svc.groups, models: mp.models, providers: mp.providers };
  });
  const { data } = state;

  return (
    <div>
      <PageHeader title={t("overview.page.title")} subtitle={t("overview.page.subtitle")} icon={ENTITY_ICON.overview} />
      <div className="mb-6">
        <EndpointsCard />
      </div>
      <AsyncStatus state={state} />
      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            {METRICS.map((m) => (
              <StatCard key={m.key} icon={m.icon} tone={METRIC_TONE[m.tone].text} label={t(m.label)} value={m.format(data.summary[m.key])} hint={m.hint?.(data.summary)} />
            ))}
          </div>

          <TrafficChart points={data.points} />

          <div className="grid gap-4 md:grid-cols-3">
            {TOP_LISTS.map((l) => (
              <TopList key={l.groups} title={t(l.title)} icon={l.icon} groups={data[l.groups]} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
