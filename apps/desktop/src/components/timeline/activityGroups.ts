import type { TimelineItem } from "@/lib/types";

export interface ActivityGrouping {
  /** Row indices (into `items`); a group is represented by the index of its first member. */
  rows: number[];
  /** Group members (indices into `items`) keyed by the first member's index. Always >= 2 members. */
  groups: Map<number, number[]>;
}

/** Minimum run length that collapses into one row. */
export const MIN_GROUP = 2;

/**
 * Collapse runs of consecutive "activity" rows (plain tool calls, thoughts, and agent messages
 * that aren't the final answer of their turn) into single group rows. Depends only on structure.
 * `top` are the top-level row indices, in order. `foldTail`: the agent is only waiting on
 * sub-agents, so the trailing run collapses even when it's a single row (calls that arrive
 * before the adapter attributes them to a sub-agent would otherwise pop in and out).
 * `keep`: ids of standalone rows that are on screen; they stay standalone (a barrier between runs)
 * instead of being folded into a group, so the visible content doesn't collapse under the reader.
 */
export function groupActivity(
  items: TimelineItem[],
  top: number[],
  { foldTail = false, keep }: { foldTail?: boolean; keep?: ReadonlySet<string> } = {},
): ActivityGrouping {
  const answers = finalAnswers(items, top);

  const isActivity = (i: number): boolean => {
    const it = items[i];
    if (!it) return false;
    if (it.kind === "tool_call") return !it.subagent;
    if (it.kind === "thought") return true;
    return it.kind === "agent_message" && !answers.has(i);
  };

  const rows: number[] = [];
  const groups = new Map<number, number[]>();
  let run: number[] = [];
  const flush = (min = MIN_GROUP) => {
    if (run.length >= min) {
      rows.push(run[0]);
      groups.set(run[0], run);
    } else rows.push(...run);
    run = [];
  };
  for (const i of top) {
    if (keep?.has(items[i]?.id)) {
      flush();
      rows.push(i);
    } else if (isActivity(i)) run.push(i);
    else {
      flush();
      rows.push(i);
    }
  }
  flush(foldTail ? 1 : MIN_GROUP);
  return { rows, groups };
}

/** Index of the last agent_message of each turn (turns are delimited by user messages). */
export function finalAnswers(items: TimelineItem[], top: number[]): Set<number> {
  const answers = new Set<number>();
  let lastMsg = -1;
  for (const i of top) {
    const k = items[i]?.kind;
    if (k === "user_message") {
      if (lastMsg >= 0) answers.add(lastMsg);
      lastMsg = -1;
    } else if (k === "agent_message") lastMsg = i;
  }
  if (lastMsg >= 0) answers.add(lastMsg);
  return answers;
}

export interface KeepRow {
  id: string;
  /** Top-level row that isn't an activity group. */
  standalone: boolean;
  start: number;
  end: number;
}

/** Rows shorter than this (one collapsed line) aren't worth keeping unfolded. */
export const KEEP_MIN_HEIGHT = 40;
/** A row this close to the viewport still counts as visible. */
export const KEEP_MARGIN = 100;

/**
 * Which standalone rows must stay unfolded: the tall ones in (or near) the viewport. A kept row is
 * released once it is fully outside the viewport, but only when that cannot move what is on screen:
 * the reader is pinned to the bottom, or the row sits below the viewport. Returns `prev` when unchanged.
 */
export function nextKeep(
  prev: ReadonlySet<string>,
  visible: KeepRow[],
  lookup: (id: string) => { start: number; end: number } | undefined,
  view: { top: number; bottom: number },
  pinned: boolean,
): ReadonlySet<string> {
  const near = (r: { start: number; end: number }) =>
    r.end > view.top - KEEP_MARGIN && r.start < view.bottom + KEEP_MARGIN;
  const next = new Set<string>();
  for (const r of visible) {
    if (r.standalone && r.end - r.start > KEEP_MIN_HEIGHT && near(r)) next.add(r.id);
  }
  for (const id of prev) {
    if (next.has(id)) continue;
    const r = lookup(id);
    if (!r) continue;
    if (near(r)) next.add(id);
    else if (!pinned && r.end <= view.top - KEEP_MARGIN) next.add(id);
  }
  if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
  return next;
}
