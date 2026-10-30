/**
 * Images the agent references by local path (screenshots), fetched on demand
 * from GET /api/agents/{id}/image and cached with a byte budget (LRU).
 */
import type { Attachment } from "./types";

const MAX_BYTES = 16 * 1024 * 1024; // base64 characters kept in memory
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;

/** An absolute local path (POSIX, ~, or Windows) to an image file. */
export function isLocalImagePath(p: string): boolean {
  const s = p.trim();
  return /^(\/|~\/|[A-Za-z]:[\\/])/.test(s) && !s.startsWith("//") && IMAGE_EXT.test(s) && !/[\n\r]/.test(s);
}

/**
 * What a markdown image source (`![alt](src)`) refers to, like the desktop app: a file in the
 * agent's folders (an absolute or relative path, or a `file://` URL), or null for a web or inline
 * source, which is never fetched and shows as a chip instead.
 */
export function markdownImagePath(src: string): string | null {
  const s = src.trim();
  // Network-path references (`//host/share/a.png`, `\\host\share\a.png`) would make a Windows host contact
  // another machine; any other URL scheme (two or more characters, so `C:\` drive paths still work) isn't a file.
  if (!s || /^(\/\/|\\\\)/.test(s) || (/^[a-z][a-z0-9+.-]+:/i.test(s) && !/^file:/i.test(s))) return null;
  let path: string;
  if (/^file:/i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== "file:" || (u.hostname && u.hostname !== "localhost")) return null; // file://host/share is a network path
      path = decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
    } catch {
      return null;
    }
  } else {
    // Markdown URLs are percent-encoded ("my%20shot.png"); the file on disk isn't.
    try {
      path = decodeURIComponent(s);
    } catch {
      path = s;
    }
  }
  // Re-check after decoding ("%2F%2Fhost/…", "file:////host/…").
  return /^(\/\/|\\\\)/.test(path) ? null : path;
}

const cache = new Map<string, Attachment>();
let bytes = 0;
const inflight = new Map<string, Promise<Attachment>>();

const keyOf = (agentId: string, path: string) => `${agentId}\u0000${path}`;

export function cachedLocalImage(agentId: string, path: string): Attachment | undefined {
  const k = keyOf(agentId, path);
  const hit = cache.get(k);
  if (hit) {
    cache.delete(k);
    cache.set(k, hit);
  }
  return hit;
}

function remember(k: string, a: Attachment) {
  cache.set(k, a);
  bytes += a.data.length;
  for (const [key, v] of cache) {
    if (bytes <= MAX_BYTES || key === k) break;
    cache.delete(key);
    bytes -= v.data.length;
  }
}

/** Load (once, shared between callers) through `fetcher`. */
export function loadLocalImage(agentId: string, path: string, fetcher: () => Promise<Attachment>): Promise<Attachment> {
  const k = keyOf(agentId, path);
  const hit = cachedLocalImage(agentId, path);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p) {
    p = fetcher()
      .then((a) => {
        if (!a || typeof a.data !== "string" || typeof a.mimeType !== "string") throw new Error("Not an image");
        remember(k, a);
        return a;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}
