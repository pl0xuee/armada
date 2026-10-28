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
  return /^(\/|~\/|[A-Za-z]:[\\/])/.test(s) && IMAGE_EXT.test(s) && !/[\n\r]/.test(s);
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
