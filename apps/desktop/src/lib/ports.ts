// Dev-server URL detection from terminal / tool output, and loopback URL validation for the
// Preview tab. Pure functions; the "is it really listening" check lives in the backend.

// Strips ANSI escape sequences (colors, cursor moves) that dev servers sprinkle into URLs.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const URL_RE = /\bhttps?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{1,5})(\/[^\s"'<>)\]]*)?/gi;
// "listening on 0.0.0.0:3000", "Listening at port 3000", "running on 127.0.0.1:8000"
const LISTEN_RE =
  /\b(?:listening|running|serving|started|available)\b[^\n]{0,40}?\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})\b/gi;

export interface DetectedUrl {
  url: string;
  port: number;
}

function toLoopback(host: string, port: number, path = ""): DetectedUrl | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const h = /^(0\.0\.0\.0|\[::1?\])$/.test(host.toLowerCase()) ? "localhost" : host.toLowerCase();
  const p = path === "/" ? "" : path.replace(/[.,;:]+$/, "");
  return { url: `http://${h}:${port}${p || "/"}`, port };
}

/** Every loopback mention in `text` with its position (ANSI stripped first). */
function mentions(text: string): (DetectedUrl & { at: number })[] {
  const clean = text.replace(ANSI, "");
  const found: (DetectedUrl & { at: number })[] = [];
  for (const m of clean.matchAll(URL_RE)) {
    // Keep the scheme the server printed.
    const d = toLoopback(m[1], Number(m[2]), m[3]);
    if (d)
      found.push({
        ...d,
        url: m[0].toLowerCase().startsWith("https") ? d.url.replace("http:", "https:") : d.url,
        at: m.index,
      });
  }
  for (const m of clean.matchAll(LISTEN_RE)) {
    const d = toLoopback(m[1], Number(m[2]));
    if (d) found.push({ ...d, at: m.index });
  }
  found.sort((a, b) => a.at - b.at);
  return found;
}

/** Loopback dev-server URLs mentioned in `text`, in order of appearance, one per port. */
export function detectDevUrls(text: string): DetectedUrl[] {
  const found = mentions(text);
  const byPort = new Map<number, DetectedUrl>();
  for (const f of found) {
    // A later mention of the same port wins only if it carries a path; otherwise keep the first.
    if (!byPort.has(f.port)) byPort.set(f.port, { url: f.url, port: f.port });
  }
  return [...byPort.values()];
}

/**
 * Loopback servers mentioned in `text`, ranked by their most recent mention: the last element is the
 * port mentioned last (what the agent said most recently wins over an older, e.g. "4321 was taken").
 * One entry per port; its URL is the one from the latest mention that carried a path, else the latest.
 */
export function rankDevUrls(text: string): DetectedUrl[] {
  const last = new Map<number, { at: number; url: string }>();
  for (const m of mentions(text)) {
    const prev = last.get(m.port);
    const pathful = !m.url.endsWith(`:${m.port}/`);
    // Keep an earlier URL with a path when the later mention is a bare host:port.
    const url = !pathful && prev && !prev.url.endsWith(`:${m.port}/`) ? prev.url : m.url;
    last.set(m.port, { at: m.at, url });
  }
  return [...last.entries()].sort((a, b) => a[1].at - b[1].at).map(([port, v]) => ({ url: v.url, port }));
}

/** Normalises user input to an http(s) loopback URL, or null if it isn't one. */
export function parseLoopbackUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return null;
  return u.href;
}

/** Port of a (valid) loopback URL, with the scheme default when absent. */
export function urlPort(url: string): number {
  const u = new URL(url);
  return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
}

/**
 * The URL to actually load given which loopback families accept on its port. A dev server bound only
 * to ::1 (Node's "localhost") refuses 127.0.0.1, and WebKitGTK rejects `[::1]` in CSP frame-src, so
 * anything but a v4 host with a v4 listener loads as `localhost`, which the engine resolves to
 * whichever family answers. Returns null when nothing listens.
 */
export function effectiveLoopbackUrl(url: string, fam: { v4: boolean; v6: boolean }): string | null {
  if (!fam.v4 && !fam.v6) return null;
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (host === "127.0.0.1" && fam.v4) return url;
  if (host === "localhost") return url;
  u.hostname = "localhost";
  return u.href;
}
