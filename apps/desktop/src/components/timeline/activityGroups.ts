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
 * Collapse runs of consecutive plain tool calls and thoughts into single group rows. Agent messages
 * are never folded: what the agent says stays where it is, so nothing the reader is looking at moves
 * or disappears when the next step starts. Depends only on the items' kinds (never on what is on screen
 * or whether the agent is still working), so a row never flips between standalone and folded: a run only
 * ever grows. `top` are the top-level row indices, in order.
 */
export function groupActivity(items: TimelineItem[], top: number[]): ActivityGrouping {
  const isActivity = (i: number): boolean => {
    const it = items[i];
    if (!it) return false;
    if (it.kind === "tool_call") return !it.subagent;
    return it.kind === "thought";
  };

  const rows: number[] = [];
  const groups = new Map<number, number[]>();
  let run: number[] = [];
  const flush = () => {
    if (run.length >= MIN_GROUP) {
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
  flush();
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
    } else if (k === "agent_message") {
      // A picture doesn't replace the text before it as the turn's answer.
      const m = items[i];
      if (!(m?.kind === "agent_message" && m.images?.length && !m.text.trim())) lastMsg = i;
    }
  }
  if (lastMsg >= 0) answers.add(lastMsg);
  return answers;
}
