const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });

// Building an Intl.DateTimeFormat is ~50x slower than formatting with one, and timestamps render per row.
function dateFormat(options: Intl.DateTimeFormatOptions) {
  let fmt: Intl.DateTimeFormat | undefined;
  return (ts: number): string => {
    const date = new Date(ts);
    // toLocale*String returns this for bad input; Intl.DateTimeFormat#format would throw.
    if (Number.isNaN(date.getTime())) return "Invalid Date";
    return (fmt ??= new Intl.DateTimeFormat(undefined, options)).format(date);
  };
}

const shortDay = dateFormat({ month: "short", day: "numeric" });
const timeOfDay = dateFormat({ hour: "numeric", minute: "2-digit" });
const shortDate = dateFormat({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const longDate = dateFormat({
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** Compact relative time: "now", "3m", "2h", "Yesterday", "Mar 4". */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 45) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "1d";
  if (d < 7) return `${d}d`;
  return shortDay(ts);
}

/** Longer relative time for tooltips / headers: "3 min. ago". */
export function relativeTimeLong(ts: number, now = Date.now()): string {
  const diff = (ts - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function clockTime(ts: number): string {
  return timeOfDay(ts);
}

export function fullDate(ts: number): string {
  return shortDate(ts);
}

/** Locale date and time with seconds, as `Date#toLocaleString()` prints it. */
export function fullDateTime(ts: number): string {
  return longDate(ts);
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

/** An agent's cost for display: local models are free, everything else is priced per token. */
export function agentCostText(agent: { provider: string; costUsd: number }): string {
  return agent.provider === "local" ? "Free" : formatCost(agent.costUsd);
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function pluralize(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "142 MB", "1.2 GB" (decimal units, like the OS file manager). */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}
