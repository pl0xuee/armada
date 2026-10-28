// Per-agent composer drafts (text only). Kept in memory for instant switching and
// persisted to localStorage (debounced) so they survive restarts. Bounded and pruned.
import { useApp } from "@/store/app";

const KEY = "armada.drafts";
const MAX_DRAFTS = 50;
const MAX_CHARS = 20_000;

const drafts = new Map<string, string>(load());
let timer: ReturnType<typeof setTimeout> | null = null;

function load(): [string, string][] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return [];
    return Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
  } catch {
    return [];
  }
}

function persist() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    // Drop drafts of agents that no longer exist (once agents are loaded).
    const agents = useApp.getState().agents;
    if (Object.keys(agents).length > 0) {
      for (const id of [...drafts.keys()]) if (!agents[id]) drafts.delete(id);
    }
    // Keep the most recently written drafts (Map preserves insertion order).
    while (drafts.size > MAX_DRAFTS) {
      const oldest = drafts.keys().next().value;
      if (oldest === undefined) break;
      drafts.delete(oldest);
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(drafts)));
    } catch {
      /* storage full or unavailable: in-memory drafts still work */
    }
  }, 400);
}

export function getDraft(agentId: string): string {
  return drafts.get(agentId) ?? "";
}

export function setDraft(agentId: string, text: string) {
  drafts.delete(agentId);
  if (text) drafts.set(agentId, text.slice(0, MAX_CHARS));
  persist();
}
