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
