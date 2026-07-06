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
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "0";
  return n.toLocaleString();
}

export function formatCompact(n: number | null | undefined): string {
  if (n == null) return "0";
  if (Math.abs(n) >= 1000) {
    // Pin the locale: browser locales like zh-CN would compact to 万/亿
    // instead of k/M/B.
    return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  }
  return String(n);
}
