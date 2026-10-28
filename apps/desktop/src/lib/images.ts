import { api } from "./api";
import type { Attachment } from "./types";
import { errorMessage } from "./utils";

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path.split(/[?#]/)[0]);
}

/** Markdown image sources that refer to the agent's files (not remote / inline data). */
export function localImagePath(src: string): string | null {
  const s = src.trim();
  if (!s || /^(https?:|data:|blob:|mailto:)/i.test(s)) return null;
  if (/^file:\/\//i.test(s)) {
    try {
      return decodeURIComponent(new URL(s).pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
    } catch {
      return null;
    }
  }
  // Markdown URLs are percent-encoded ("my%20shot.png"); the file on disk isn't.
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

type Entry = { state: "ok"; image: Attachment } | { state: "error"; error: string };

/** Successful loads: LRU capped by (decoded) bytes. */
const MAX_BYTES = 100 * 1024 * 1024;
/** Errors are remembered only briefly (the file may appear, or the agent may fix it). */
const ERROR_TTL_MS = 10_000;

const ok = new Map<string, { image: Attachment; bytes: number }>();
let okBytes = 0;
const errors = new Map<string, { error: string; at: number }>();
const inflight = new Map<string, Promise<Entry>>();

const keyOf = (agentId: string, path: string) => `${agentId}\u0000${path}`;

function remember(key: string, image: Attachment) {
  const bytes = Math.ceil((image.data.length * 3) / 4);
  const prev = ok.get(key);
  if (prev) okBytes -= prev.bytes;
  ok.delete(key);
  ok.set(key, { image, bytes });
  okBytes += bytes;
  // Evict least recently used until under the cap (always keep the newest).
  for (const [k, v] of ok) {
    if (okBytes <= MAX_BYTES || k === key) break;
    ok.delete(k);
    okBytes -= v.bytes;
  }
}

export function cachedAgentImage(agentId: string, path: string): Entry | undefined {
  const key = keyOf(agentId, path);
  const hit = ok.get(key);
  if (hit) {
    // Touch for LRU order.
    ok.delete(key);
    ok.set(key, hit);
    return { state: "ok", image: hit.image };
  }
  const err = errors.get(key);
  if (err && Date.now() - err.at < ERROR_TTL_MS) return { state: "error", error: err.error };
  return undefined;
}

/** Load an agent-referenced image once per (agent, path). `force` bypasses cached errors (Retry). */
export function loadAgentImage(agentId: string, path: string, force = false): Promise<Entry> {
  const key = keyOf(agentId, path);
  if (force) errors.delete(key);
  const hit = cachedAgentImage(agentId, path);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = api
      .readImage(agentId, path)
      .then((image): Entry => {
        errors.delete(key);
        remember(key, image);
        return { state: "ok", image };
      })
      .catch((e: unknown): Entry => {
        const error = errorMessage(e);
        errors.set(key, { error, at: Date.now() });
        return { state: "error", error };
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}
