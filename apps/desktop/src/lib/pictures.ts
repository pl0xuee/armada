import { api } from "./api";
import { attachmentSrc } from "./attachments";

/**
 * Pictures stored as files in the timeline are loaded one by one, when a picture is shown, and
 * kept as data: URLs in a cache capped by size (least recently used go first).
 */
const MAX_BYTES = 64 * 1024 * 1024;

const cache = new Map<string, { src: string; bytes: number }>();
let cached = 0;
const inflight = new Map<string, Promise<string>>();

export function cachedPicture(path: string): string | undefined {
  const hit = cache.get(path);
  if (!hit) return undefined;
  // Touch for LRU order.
  cache.delete(path);
  cache.set(path, hit);
  return hit.src;
}

export function loadPicture(path: string): Promise<string> {
  const hit = cachedPicture(path);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(path);
  if (!p) {
    p = api
      .readPicture(path)
      .then((a) => {
        const src = attachmentSrc(a);
        cache.set(path, { src, bytes: src.length });
        cached += src.length;
        for (const [k, v] of cache) {
          if (cached <= MAX_BYTES || k === path) break;
          cache.delete(k);
          cached -= v.bytes;
        }
        return src;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, p);
  }
  return p;
}
