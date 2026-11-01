// The last Preview address per project, so a new agent in the same folder (or the same agent after a
// restart) opens where the last one left off. Only loopback URLs are ever stored or returned (the same
// rule as the address bar), whatever is in storage. Pure apart from localStorage.
import { parseLoopbackUrl } from "@/lib/ports";

const KEY = "armada.preview.project.v1";
/** Projects remembered; the least recently used fall off. */
export const MAX_PROJECTS = 50;

function read(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [path, url] of Object.entries(raw)) {
      const ok = typeof url === "string" ? parseLoopbackUrl(url) : null;
      if (path && ok) out[path] = ok;
    }
    return out;
  } catch {
    return {};
  }
}

/** The project's remembered URL, or null. */
export function projectUrl(projectPath: string): string | null {
  return read()[projectPath] ?? null;
}

/** Remembers `url` for the project; anything that isn't a loopback URL is ignored. Returns whether it stored. */
export function rememberProjectUrl(projectPath: string, url: string): boolean {
  const ok = parseLoopbackUrl(url);
  if (!projectPath || !ok) return false;
  const all = read();
  if (all[projectPath] === ok) return true;
  delete all[projectPath]; // re-insert last: object order is recency
  all[projectPath] = ok;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PROJECTS))) delete all[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the address is just not remembered */
  }
  return true;
}
