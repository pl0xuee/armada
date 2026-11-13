// Lines the agent's edits added and removed, for the Review button and the details card of the Minimal look.
// Summed over the edits in the conversation (a line edited twice counts twice), so it is a size hint: the
// review itself shows git's numbers. Cached per diff and per list of touched files (agentDerived keeps that
// list's reference until a tool call changes), so streamed text never recomputes it.
import type { FileDiff, TimelineItem } from "@/lib/types";
import { cheapStats } from "../timeline/diffCache";

export interface EditStats {
  additions: number;
  deletions: number;
}

const NONE: EditStats = { additions: 0, deletions: 0 };
const perDiff = new WeakMap<FileDiff, EditStats>();
const perList = new WeakMap<object, EditStats>();

/** +/- over every tool call's diffs. */
export function sumEdits(items: TimelineItem[]): EditStats {
  let additions = 0;
  let deletions = 0;
  for (const it of items) {
    if (it.kind !== "tool_call") continue;
    for (const d of it.diffs) {
      let s = perDiff.get(d);
      if (!s) perDiff.set(d, (s = cheapStats(d)));
      additions += s.additions;
      deletions += s.deletions;
    }
  }
  return additions || deletions ? { additions, deletions } : NONE;
}

/**
 * `key`: an object that is replaced only when the tool calls change (the derived list of touched files).
 * `partial`: older history is not loaded yet. Nothing is counted then, so the total doesn't grow as you
 * scroll up. Returns the same object until the numbers change (safe as a store selector's result).
 */
export function editStats(key: object, items: TimelineItem[] | undefined, partial = false): EditStats {
  if (partial || !items || items.length === 0) return NONE;
  let s = perList.get(key);
  if (!s) perList.set(key, (s = sumEdits(items)));
  return s;
}
