/**
 * Folding finished work into one line. Pure logic, the phone's copy of the desktop's
 * `activityGroups.ts` (`groupActivity`, `finalAnswers`, `nextKeep`) and of the summary text
 * in `ActivityGroup.tsx`: runs of plain tool calls, thoughts and interim messages collapse into
 * one row; each turn's final answer and any reply with a picture stay in view.
 */
import { plural } from "./format";
import type { TimelineItem } from "./types";

export interface ActivityGrouping {
  /** Row indices (into `items`); a group is represented by the index of its first member. */
  rows: number[];
  /** Group members (indices into `items`) keyed by the first member's index. Always >= 2 members (1 with `foldTail`). */
  groups: Map<number, number[]>;
}

/** Minimum run length that collapses into one row. */
export const MIN_GROUP = 2;

/** Index of the last agent_message of each turn (turns are delimited by user messages). */
export function finalAnswers(items: TimelineItem[], top: number[]): Set<number> {
  const answers = new Set<number>();
  let lastMsg = -1;
  for (const i of top) {
    const it = items[i];
    if (it?.kind === "user_message") {
      if (lastMsg >= 0) answers.add(lastMsg);
      lastMsg = -1;
    } else if (it?.kind === "agent_message") {
      // A picture-only reply doesn't replace the text before it as the turn's answer.
      if (!(it.images?.length && !it.text.trim())) lastMsg = i;
    }
  }
  if (lastMsg >= 0) answers.add(lastMsg);
  return answers;
}

/**
 * Collapse runs of consecutive "activity" rows (plain tool calls, thoughts, and agent messages
 * that aren't the final answer of their turn) into single group rows. Depends only on structure.
 * `top` are the top-level row indices, in order. `foldTail`: the agent is only waiting on
 * sub-agents, so the trailing run collapses even when it is a single row. `keep`: ids of
 * standalone rows that are on screen; they stay standalone (a barrier between runs) instead of
 * being folded into a group, so the content being read doesn't collapse under the reader.
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
    // Sub-agent launchers are cards of their own; Codex wait/close calls are plain tool calls.
    if (it.kind === "tool_call") return !it.subagent || !!it.subagent.control;
    if (it.kind === "thought") return true;
    // A reply with a picture stays in view rather than folding into a group.
    return it.kind === "agent_message" && !answers.has(i) && !it.images?.length;
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

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Which groups are open, given the ids the reader opened. An opened group is remembered by its first
 * member, but a group's key changes when runs merge (the run before it joins), so a group counts as open
 * when ANY of its members was an opened key.
 */
export function openGroupKeys(rows: readonly { kind: string; key: string; items?: readonly { id: string }[] }[], opened: ReadonlySet<string>): ReadonlySet<string> {
  if (!opened.size) return NO_KEYS;
  const out = new Set<string>();
  for (const r of rows) if (r.kind === "group" && (opened.has(r.key) || r.items?.some((it) => opened.has(it.id)))) out.add(r.key);
  return out.size ? out : NO_KEYS;
}

export interface KeepRow {
  id: string;
  /** Top-level row that isn't an activity group. */
  standalone: boolean;
  start: number;
  end: number;
}

/** Rows shorter than this (about one line) aren't worth keeping unfolded. */
export const KEEP_MIN_HEIGHT = 56;
/** A row this close to the viewport still counts as visible. */
export const KEEP_MARGIN = 100;

/**
 * Which standalone rows must stay unfolded: the tall ones in (or near) the viewport. A kept row is
 * released once it is fully outside the viewport, but only when that cannot move what is on screen:
 * the reader is pinned to the bottom, or the row sits below the viewport. Returns `prev` when unchanged.
 * `lookup` returns undefined for a row that isn't mounted (its position is unknown): it is then
 * released only while pinned.
 */
export function nextKeep(
  prev: ReadonlySet<string>,
  visible: KeepRow[],
  lookup: (id: string) => { start: number; end: number } | undefined,
  view: { top: number; bottom: number },
  pinned: boolean,
): ReadonlySet<string> {
  const near = (r: { start: number; end: number }) => r.end > view.top - KEEP_MARGIN && r.start < view.bottom + KEEP_MARGIN;
  const next = new Set<string>();
  for (const r of visible) {
    if (r.standalone && r.end - r.start > KEEP_MIN_HEIGHT && near(r)) next.add(r.id);
  }
  for (const id of prev) {
    if (next.has(id)) continue;
    const r = lookup(id);
    if (!r) {
      if (!pinned) next.add(id);
      continue;
    }
    if (near(r)) next.add(id);
    else if (!pinned && r.end <= view.top - KEEP_MARGIN) next.add(id);
  }
  if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
  return next;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.replace(/[*_`#>]/g, "").trim())
      .find(Boolean) ?? ""
  );
}

/** "Read 4 files, edited 2 files, ran 3 commands, 1 search". */
export function summarizeActivity(items: TimelineItem[]): { text: string; failed: number } {
  let read = 0,
    edit = 0,
    run = 0,
    search = 0,
    fetch = 0,
    other = 0,
    failed = 0,
    tools = 0;
  for (const it of items) {
    if (it.kind !== "tool_call") continue;
    tools++;
    if (it.status === "failed") failed++;
    switch (it.toolKind) {
      case "read":
        read++;
        break;
      case "edit":
      case "delete":
      case "move":
        edit++;
        break;
      case "execute":
        run++;
        break;
      case "search":
        search++;
        break;
      case "fetch":
        fetch++;
        break;
      default:
        other++;
    }
  }
  const parts: string[] = [];
  if (read) parts.push(`read ${plural(read, "file")}`);
  if (edit) parts.push(`edited ${plural(edit, "file")}`);
  if (run) parts.push(`ran ${plural(run, "command")}`);
  // Searches continue a "ran 2 commands, 1 search" list; otherwise each part carries its own verb.
  if (search) parts.push(run ? plural(search, "search", "searches") : `ran ${plural(search, "search", "searches")}`);
  if (fetch) parts.push(`fetched ${plural(fetch, "page")}`);
  // "…, 1 other tool" extends the list; alone it reads "used 1 tool".
  if (other) parts.push(parts.length ? plural(other, "other tool") : `used ${plural(other, "tool")}`);
  let text: string;
  if (tools === 0) text = items.some((i) => i.kind === "thought") ? "Thought for a moment" : plural(items.length, "step");
  else {
    text = parts.join(", ");
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  return { text, failed };
}

/** What a live group shows instead of its summary: the step the agent is on right now. */
export function currentStep(last: TimelineItem | undefined): { kind: "tool" | "thought" | "message"; text: string } | null {
  if (!last) return null;
  if (last.kind === "tool_call") return { kind: "tool", text: last.title };
  if (last.kind === "thought") return { kind: "thought", text: "Thinking…" };
  if (last.kind === "agent_message") return { kind: "message", text: firstLine(last.text) || "Writing…" };
  return null;
}
