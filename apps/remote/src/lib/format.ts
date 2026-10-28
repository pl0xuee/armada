// Intl formatters are expensive to create; toLocale*String() builds a new one per
// call, which showed up in profiles when hundreds of rows mount at once.
let timeFmt: Intl.DateTimeFormat | null = null;
let dayFmt: Intl.DateTimeFormat | null = null;
const timeFormat = () => (timeFmt ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }));
const dayFormat = () => (dayFmt ??= new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }));

/** Compact relative time: "now", "3m", "2h", "4d", "Mar 4". */
export function relativeTime(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts)) return "";
  const s = Math.floor(Math.max(0, now - ts) / 1000);
  if (s < 45) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return dayFormat().format(ts);
}

/** Spoken/long form for accessibility labels and tooltips. */
export function relativeTimeLong(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts)) return "";
  const s = Math.floor(Math.max(0, now - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? "yesterday" : `${d} days ago`;
  return dayFormat().format(ts);
}

export function clockTime(ts: number): string {
  return timeFormat().format(ts);
}

export function formatCost(usd: number | null | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/** "820 B", "12 KB", "1.4 MB" (characters ≈ bytes for display purposes). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Last path segment; "" for a missing path (share links omit paths). */
export function basename(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Last `n` path segments, for showing files compactly on narrow screens. */
export function shortPath(path: string, n = 2): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= n) return path;
  return `…/${parts.slice(-n).join("/")}`;
}

export function wordCount(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/** Collapse whitespace and strip the most common markdown syntax for one-line previews. */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "42s", "4m 12s", "1h 5m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(s, ms > 0 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
