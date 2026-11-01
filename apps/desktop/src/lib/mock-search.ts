// Conversation search for the browser mock: the same rules as the backend's SQLite index
// (every word must appear, the last as a prefix; messages, tool names and paths, plans,
// summaries; no private reasoning), over the in-memory timelines.

import type { SearchGroup, SearchHit, SearchResults, TimelineItem } from "./types";

const MAX_HITS = 400;
const PER_AGENT = 3;

/** What is searchable about an item (mirrors `item_text` in the Rust core). */
export function itemText(it: TimelineItem): string {
  switch (it.kind) {
    case "user_message":
    case "agent_message":
    case "notice":
      return it.text;
    case "tool_call":
      return [it.title, it.command ?? "", ...it.locations, ...it.diffs.map((d) => d.path)].join(" ");
    case "permission":
      return [it.title, it.command ?? "", ...it.diffs.map((d) => d.path), it.plan ?? ""].join(" ");
    case "question":
      return it.message;
    case "plan":
      return it.entries.map((e) => e.content).join(" ");
    case "turn_summary":
      return it.files.join(" ");
    default:
      return "";
  }
}

const WORD = /[\p{L}\p{N}]+/gu;

function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/** The typed words; the last one matches as a prefix. */
export function queryTerms(query: string): string[][] {
  return query
    .split(/\s+/)
    .map(words)
    .filter((w) => w.length > 0)
    .slice(0, 12);
}

function snippetOf(text: string, first: RegExp): string {
  const flat = text.replace(/\s+/g, " ");
  const m = first.exec(flat);
  const at = m?.index ?? 0;
  const start = Math.max(0, at - 50);
  const end = Math.min(flat.length, at + 110);
  const cut = flat.slice(start, end);
  return `${start > 0 ? "…" : ""}${cut}${end < flat.length ? "…" : ""}`;
}

function esc(w: string) {
  return w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Searches every conversation; best matches (most recent among equals) first. */
export function searchItems(items: Record<string, TimelineItem[]>, query: string): SearchResults {
  const groupsOfTerms = queryTerms(query);
  if (groupsOfTerms.length === 0) return { groups: [], indexing: false, truncated: false };
  const flat = groupsOfTerms.flat();
  const lastGroup = groupsOfTerms.length - 1;
  const hits: { hit: SearchHit; score: number }[] = [];
  for (const [agentId, list] of Object.entries(items)) {
    for (const it of list) {
      const text = itemText(it);
      if (!text) continue;
      const have = words(text);
      const ok = groupsOfTerms.every((g, gi) =>
        g.every((t, ti) => {
          const prefix = gi === lastGroup && ti === g.length - 1;
          return have.some((h) => (prefix ? h.startsWith(t) : h === t));
        }),
      );
      if (!ok) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${flat.map(esc).join("|")})[\\p{L}\\p{N}]*`, "giu");
      const snippet = snippetOf(text, re).replace(re, (m) => `\u0001${m}\u0002`);
      // Short items rank above long ones, like bm25.
      hits.push({
        hit: { agentId, itemId: it.id, kind: it.kind, snippet, ts: it.ts, seq: it.seq },
        score: have.length,
      });
    }
  }
  hits.sort((a, b) => a.score - b.score || b.hit.ts - a.hit.ts);
  const order: string[] = [];
  const groups = new Map<string, SearchGroup>();
  for (const { hit } of hits.slice(0, MAX_HITS)) {
    let g = groups.get(hit.agentId);
    if (!g) {
      g = { agentId: hit.agentId, hits: [], total: 0 };
      groups.set(hit.agentId, g);
      order.push(hit.agentId);
    }
    g.total++;
    if (g.hits.length < PER_AGENT) g.hits.push(hit);
  }
  return { groups: order.map((id) => groups.get(id)!), indexing: false, truncated: hits.length > MAX_HITS };
}
