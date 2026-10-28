/** Compact relative time: "now", "3m", "2h", "4d", "Mar 4". */
export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.floor(Math.max(0, now - ts) / 1000);
  if (s < 45) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Spoken/long form for accessibility labels and tooltips. */
export function relativeTimeLong(ts: number, now = Date.now()): string {
  const s = Math.floor(Math.max(0, now - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? "yesterday" : `${d} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatCost(usd: number): string {
  if (!usd) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function basename(path: string): string {
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
