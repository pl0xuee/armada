import type { SearchHit } from "./types";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

/** Wraps each matched word in a snippet (the backend's `MARK_START` / `MARK_END`). */
const MARK_START = "\u0001";
const MARK_END = "\u0002";

export interface SnippetPart {
  text: string;
  /** This part is a match. */
  hit: boolean;
}

/** Splits a snippet into plain and matched parts, in order. Stray markers are dropped. */
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let hit = false;
  let text = "";
  const flush = () => {
    if (text) parts.push({ text, hit });
    text = "";
  };
  for (const ch of snippet) {
    if (ch === MARK_START || ch === MARK_END) {
      flush();
      hit = ch === MARK_START;
    } else {
      text += ch;
    }
  }
  flush();
  return parts;
}

/** The snippet without its markers (screen readers, titles). */
export function plainSnippet(snippet: string): string {
  return snippet.replaceAll(MARK_START, "").replaceAll(MARK_END, "");
}

/** What the query is, without the palette's "?" search-mode prefix. */
export function searchTerm(query: string): string {
  const q = query.trimStart();
  return (q.startsWith("?") ? q.slice(1) : q).trim();
}

/** Most pages of history loaded to reach a hit (a page is a few hundred items). */
const MAX_PAGES = 60;

/** Waits for an agent's timeline to be in memory (up to ~2 s). */
async function timelineLoaded(agentId: string) {
  void useApp.getState().ensureItems(agentId);
  for (let i = 0; i < 40 && !useApp.getState().items[agentId]; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Opens the agent a hit belongs to and scrolls its conversation to the item. Timelines load
 * tail-first, so older pages are loaded until the item is among them.
 */
export async function openSearchHit(hit: Pick<SearchHit, "agentId" | "itemId" | "seq">) {
  await timelineLoaded(hit.agentId);
  for (let i = 0; i < MAX_PAGES; i++) {
    const st = useApp.getState();
    const first = st.items[hit.agentId]?.[0]?.seq;
    if (first === undefined || first <= hit.seq || !st.hasOlder[hit.agentId]) break;
    await st.loadOlder(hit.agentId);
  }
  useUi.getState().revealItem(hit.agentId, hit.itemId);
}
