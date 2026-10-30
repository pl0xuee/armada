/**
 * Folding finished work into one line. Pure logic, the phone's copy of the desktop's
 * `activityGroups.ts` (`groupActivity`, `finalAnswers`, `nextKeep`) and of the summary text
 * in `ActivityGroup.tsx`: runs of plain tool calls and thoughts collapse into one row; agent
 * messages always stay in view.
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

const NO_KEYS: ReadonlySet<string> = new Set();

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
    // Sub-agent launchers are cards of their own; Codex wait/close calls are plain tool calls.
    if (it.kind === "tool_call") return !it.subagent || !!it.subagent.control;
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

/**
 * Which groups are open, given the ids the reader opened. An opened group is remembered by its first
 * member; a group counts as open when ANY of its members was an opened key.
 */
export function openGroupKeys(rows: readonly { kind: string; key: string; items?: readonly { id: string }[] }[], opened: ReadonlySet<string>): ReadonlySet<string> {
  if (!opened.size) return NO_KEYS;
  const out = new Set<string>();
  for (const r of rows) if (r.kind === "group" && (opened.has(r.key) || r.items?.some((it) => opened.has(it.id)))) out.add(r.key);
  return out.size ? out : NO_KEYS;
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
