import { HOURS_PER_DAY, MINUTES_PER_HOUR, MS_PER_SECOND, SECONDS_PER_MINUTE } from "./constants";

/** Numbers below this are shown in full; from it up they compact to k/M/B. */
const COMPACT_FROM = 1000;
const COMPACT_DECIMALS = 1;

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "-";
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return "-";
  // A timestamp ahead of this clock (skew between server and browser) reads as now.
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.round(diff / MS_PER_SECOND);
  if (sec < SECONDS_PER_MINUTE) return `${sec}s ago`;
  const min = Math.round(sec / SECONDS_PER_MINUTE);
  if (min < MINUTES_PER_HOUR) return `${min}m ago`;
  const hr = Math.round(min / MINUTES_PER_HOUR);
  if (hr < HOURS_PER_DAY) return `${hr}h ago`;
  const day = Math.round(hr / HOURS_PER_DAY);
  return `${day}d ago`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "0";
  return n.toLocaleString();
}

export function formatCompact(n: number | null | undefined): string {
  if (n == null) return "0";
  if (Math.abs(n) >= COMPACT_FROM) {
    // Pin the locale: browser locales like zh-CN would compact to 万/亿
    // instead of k/M/B.
    return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: COMPACT_DECIMALS }).format(n);
  }
  return String(n);
}

/**
 * Usage against a quota: "used / max", or just "used" when there is no limit.
 * `unlimited` names that case where the reader should be told (" · unlimited").
 */
export function formatQuota(used: number, max: number | null, unlimited?: string): string {
  if (max != null) return `${formatNumber(used)} / ${formatNumber(max)}`;
  return unlimited ? `${formatNumber(used)} · ${unlimited}` : formatNumber(used);
}
