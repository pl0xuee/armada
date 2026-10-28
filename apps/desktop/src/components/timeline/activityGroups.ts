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
 */
export function groupActivity(
  items: TimelineItem[],
  top: number[],
  { foldTail = false }: { foldTail?: boolean } = {},
): ActivityGrouping {
  // Last agent_message of each turn (turns are delimited by user messages).
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
    if (isActivity(i)) run.push(i);
    else {
      flush();
      rows.push(i);
    }
  }
  flush(foldTail ? 1 : MIN_GROUP);
  return { rows, groups };
}
