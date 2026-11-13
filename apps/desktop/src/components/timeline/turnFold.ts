import { startsTurn } from "@/lib/agents";
import { pluralize } from "@/lib/format";
import type { TimelineItem } from "@/lib/types";

/**
 * Minimal look: a finished turn folds its steps (tool calls, thoughts, working notes, answered approvals,
 * plan updates) into one "Worked for 4m 02s" line, which opens to show them as they are. What you asked,
 * what the agent answered, questions and notices always stay in view.
 */
export interface TurnFold {
  /** Item index of the run's first row: the row that carries the line, and the fold's id. */
  first: number;
  /** The run's rows (indices into `items`), `first` included. */
  rows: number[];
  /** In the latest turn, which folds only once the agent is done with it. */
  latest: boolean;
  /** How long the turn took, when its summary says so: on the turn's first fold only. */
  durationMs: number | null;
}

/** A row that is part of the work, not of the conversation. `final`: it closes its turn (the answer). */
export function isStep(it: TimelineItem, final: boolean): boolean {
  switch (it.kind) {
    case "tool_call":
    case "thought":
    case "plan":
      return true;
    case "agent_message":
      // A picture the agent posted is something it showed you, not a working note.
      return !final && !it.images?.length;
    case "permission":
      // A pending approval is a call to action; an answered plan approval is part of the conversation.
      return it.resolution !== null && !it.plan;
    default:
      return false;
  }
}

/**
 * The runs of steps a finished turn folds. `rows` are the timeline's rows in order (after grouping and
 * stitching), `finals` the rows that close a turn. Steps fold up to the answer; whatever the agent did
 * after its last message stays as it is. Depends only on the items, like `groupActivity`.
 */
export function turnFolds(
  items: readonly TimelineItem[],
  rows: readonly number[],
  finals: ReadonlySet<number>,
): TurnFold[] {
  const folds: TurnFold[] = [];
  let turn: TurnFold[] = [];
  let turnMs: number | null = null;
  let run: number[] = [];
  let answered = false;
  const endRun = () => {
    if (run.length) turn.push({ first: run[0], rows: run, latest: false, durationMs: null });
    run = [];
  };
  const endTurn = (latest: boolean) => {
    endRun();
    // One duration for the whole turn: its first line says it, later folds count their steps.
    if (turn.length) turn[0].durationMs = turnMs;
    for (const f of turn) f.latest = latest;
    folds.push(...turn);
    turn = [];
    turnMs = null;
  };
  for (const i of rows) {
    const it = items[i];
    if (!it) continue;
    if (it.kind === "user_message") {
      // A message sent into a running turn splits its steps but not the turn.
      if (startsTurn(it)) endTurn(false);
      else endRun();
      answered = false;
      continue;
    }
    if (it.kind === "turn_summary") turnMs = it.durationMs;
    if (finals.has(i)) {
      endRun();
      answered = true;
    } else if (!answered && isStep(it, false)) run.push(i);
    else endRun();
  }
  endTurn(true);
  return folds;
}

export interface FoldedRows {
  /** The rows to show. */
  rows: number[];
  /** Folds in effect (open or closed), by their first row. */
  heads: Map<number, TurnFold>;
  /** Rows shown as the steps of an open fold. */
  steps: Set<number>;
  /** Rows a closed fold hides, each with its fold's first row. */
  hidden: Map<number, number>;
}

/** The rows with every finished turn's steps folded, except the folds the reader opened. */
export function applyFolds(
  rows: readonly number[],
  folds: readonly TurnFold[],
  isOpen: (first: number) => boolean,
  latestRunning: boolean,
): FoldedRows {
  const heads = new Map<number, TurnFold>();
  const steps = new Set<number>();
  const hidden = new Map<number, number>();
  for (const f of folds) {
    // A running turn shows its steps live.
    if (f.latest && latestRunning) continue;
    heads.set(f.first, f);
    if (isOpen(f.first)) for (const r of f.rows) steps.add(r);
    else for (const r of f.rows) if (r !== f.first) hidden.set(r, f.first);
  }
  return { rows: hidden.size ? rows.filter((r) => !hidden.has(r)) : [...rows], heads, steps, hidden };
}

/** "read 3 files · edited 2 · ran 1 command", the number of steps, and how many failed. */
export function summarizeFold(items: readonly TimelineItem[]): { text: string; steps: number; failed: number } {
  let read = 0,
    edit = 0,
    run = 0,
    search = 0,
    fetch = 0,
    agents = 0,
    steps = 0,
    failed = 0;
  for (const it of items) {
    if (it.kind === "thought") steps++;
    if (it.kind !== "tool_call") continue;
    steps++;
    if (it.status === "failed") failed++;
    if (it.subagent) agents++;
    else if (it.toolKind === "read") read++;
    else if (it.toolKind === "edit" || it.toolKind === "delete" || it.toolKind === "move") edit++;
    else if (it.toolKind === "execute") run++;
    else if (it.toolKind === "search") search++;
    else if (it.toolKind === "fetch") fetch++;
  }
  const parts: string[] = [];
  if (read) parts.push(`read ${pluralize(read, "file")}`);
  // "read 3 files · edited 2": the noun is said once.
  if (edit) parts.push(read ? `edited ${edit}` : `edited ${pluralize(edit, "file")}`);
  if (run) parts.push(`ran ${pluralize(run, "command")}`);
  if (search) parts.push(pluralize(search, "search", "searches"));
  if (fetch) parts.push(pluralize(fetch, "fetch", "fetches"));
  if (agents) parts.push(pluralize(agents, "sub-agent"));
  return { text: parts.join(" · "), steps, failed };
}
