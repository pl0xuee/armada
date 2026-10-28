import { useRef } from "react";
import { lastAction, liveTail, runningSubagents } from "@/lib/agents";
import type { TimelineItem } from "@/lib/types";
import { useApp } from "@/store/app";

export interface TileSummary {
  /** Most recent tool action, e.g. "Run npm test". */
  action: string | null;
  /** Latest agent message text in this turn (raw markdown). */
  message: string | null;
  /** The message is the last timeline item (still streaming while the agent works). */
  messageIsTail: boolean;
  /** What a running agent is doing right now (current tool / thought). */
  tail: string | null;
  /** Sub-agents still running. */
  subagents: number;
}

export const EMPTY_SUMMARY: TileSummary = {
  action: null,
  message: null,
  messageIsTail: false,
  tail: null,
  subagents: 0,
};

function summarize(items: TimelineItem[] | undefined): TileSummary {
  if (!items) return EMPTY_SUMMARY;
  let message: string | null = null;
  let messageIsTail = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "agent_message" && it.text.trim()) {
      message = it.text;
      messageIsTail = i === items.length - 1;
      break;
    }
    if (it.kind === "user_message") break;
  }
  return {
    action: lastAction(items),
    message,
    messageIsTail,
    tail: liveTail(items),
    subagents: runningSubagents(items),
  };
}

const same = (a: TileSummary, b: TileSummary) =>
  a.action === b.action &&
  a.message === b.message &&
  a.messageIsTail === b.messageIsTail &&
  a.tail === b.tail &&
  a.subagents === b.subagents;

/** Tile summaries only look at the current turn; cap the scan so huge timelines stay cheap. */
const SCAN_LIMIT = 400;

/**
 * Per-agent tile summaries derived from timelines, recomputed incrementally: an agent is only
 * re-summarised when its items array changed (by reference), and each summary keeps its identity
 * until its own values change, so a delta streaming into one agent only re-renders that tile.
 */
export function useTileSummaries(): ReadonlyMap<string, TileSummary> {
  const cache = useRef({
    map: new Map<string, TileSummary>(),
    seen: new Map<string, TimelineItem[] | undefined>(),
  });
  return useApp((s) => {
    const { map: prev, seen } = cache.current;
    let next: Map<string, TileSummary> | null = null;
    const ids = Object.keys(s.agents);
    for (const id of ids) {
      const items = s.items[id];
      const old = prev.get(id);
      if (old && seen.get(id) === items) continue;
      seen.set(id, items);
      const fresh = summarize(items && items.length > SCAN_LIMIT ? items.slice(-SCAN_LIMIT) : items);
      if (old && same(old, fresh)) continue;
      next ??= new Map(prev);
      next.set(id, fresh);
    }
    if (prev.size !== ids.length) {
      next ??= new Map(prev);
      for (const id of [...next.keys()]) {
        if (!(id in s.agents)) {
          next.delete(id);
          seen.delete(id);
        }
      }
    }
    if (!next) return prev;
    cache.current = { map: next, seen };
    return next;
  });
}
