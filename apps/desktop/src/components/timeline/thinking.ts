import type { AgentStatus, TimelineItem } from "@/lib/types";

/** Friendly status verbs the indicator cycles through while the agent is busy. */
export const THINKING_VERBS = [
  "Thinking",
  "Pondering",
  "Working on it",
  "Reading the code",
  "Connecting the dots",
  "Mulling it over",
  "Figuring it out",
  "Planning next steps",
] as const;

/**
 * Whether to show the "thinking" indicator below the conversation. It fills the gap where the
 * agent is busy but nothing at the end of the timeline is visibly doing so.
 * `last` is the last top-level row's item (activity groups pass `lastIsGroup`). `messageSettled`:
 * the last agent message stopped growing a moment ago (the model is working out its next step).
 */
export function shouldShowThinking(
  status: AgentStatus,
  last: TimelineItem | undefined,
  lastIsGroup = false,
  messageSettled = false,
): boolean {
  if (status !== "working" && status !== "starting") return false;
  // A live activity group already shows its own spinner and current step.
  if (lastIsGroup) return false;
  if (!last) return true;
  switch (last.kind) {
    case "agent_message": // streaming reply, unless it went quiet
      return messageSettled;
    case "thought": // live thought
      return false;
    case "tool_call":
      return last.status !== "pending" && last.status !== "in_progress";
    case "permission":
      return last.resolution !== null; // pending: the approval card is the call to action
    default:
      return true; // user_message, plan, notice, turn_summary
  }
}

/** Start of the current turn: the latest user message, else `fallback`. */
export function turnStart(items: readonly TimelineItem[], fallback: number): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "user_message") return items[i].ts;
  return fallback;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Indicator label while the agent waits on running sub-agents instead of cycling verbs. */
export function waitingLabel(subagents: number): string {
  return `Waiting on ${subagents} sub-agent${subagents === 1 ? "" : "s"}`;
}

/** How a finished turn ended, for the end-of-turn line. */
export interface TurnEnd {
  tone: "done" | "error" | "stopped";
  label: string;
  /** Turn duration for "done" (null when unknown). */
  elapsedMs: number | null;
}

/** How the latest turn (after the last prompt) ended: a user cancel leaves a "Turn cancelled" notice. */
export function turnOutcome(items: readonly TimelineItem[]): "done" | "cancelled" {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user_message") break;
    if (it.kind === "notice" && it.text === "Turn cancelled") return "cancelled";
  }
  return "done";
}

/**
 * The compact end-of-turn line shown where the thinking indicator was, or null. Exists for the
 * latest turn of every finished agent, except when a turn summary card is the last row (the card
 * carries the "Done" emphasis itself).
 */
export function turnEndOf(
  status: AgentStatus,
  items: readonly TimelineItem[],
  lastRow: TimelineItem | undefined,
  _lastActivityAt?: number,
): TurnEnd | null {
  if (status !== "idle" && status !== "error") return null;
  if (!lastRow || lastRow.kind === "turn_summary") return null;
  const start = items.findLast((i) => i.kind === "user_message");
  if (!start) return null;
  // An error notice is already the last row: don't say it a second time.
  if (status === "error" && lastRow.kind === "notice" && lastRow.level === "error") return null;
  if (status === "error") return { tone: "error", label: "Stopped with an error", elapsedMs: null };
  if (turnOutcome(items) === "cancelled") return { tone: "stopped", label: "Stopped", elapsedMs: null };
  // The turn's own end (its last item), not lastActivityAt: archive/rename/unread bump that.
  const end = items[items.length - 1] ?? start;
  const summary = items.findLast((i, idx) => i.kind === "turn_summary" && items[idx] && i.ts >= start.ts);
  const elapsed = summary && summary.kind === "turn_summary" ? summary.durationMs : end.ts - start.ts;
  return { tone: "done", label: "Done", elapsedMs: elapsed >= 0 ? elapsed : null };
}

/** Turns longer than this get the soft "you were watching" chime. */
export const LONG_TURN_MS = 30_000;
