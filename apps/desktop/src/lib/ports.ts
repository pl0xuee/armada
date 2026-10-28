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

/** Loopback dev-server URLs mentioned in `text`, in order of appearance, one per port. */
export function detectDevUrls(text: string): DetectedUrl[] {
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
  const byPort = new Map<number, DetectedUrl>();
  for (const f of found) {
    // A later mention of the same port wins only if it carries a path; otherwise keep the first.
    if (!byPort.has(f.port)) byPort.set(f.port, { url: f.url, port: f.port });
  }
  return [...byPort.values()];
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
