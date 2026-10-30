/** The working indicator's wording, the same as the desktop's `thinking.ts`. */
import type { AgentStatus, TimelineItem } from "./types";

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

/** How often the verb changes. */
export const VERB_MS = 3000;
/** Elapsed time shows once the turn is this old. */
export const ELAPSED_AFTER_MS = 3000;

/**
 * Start of the current turn: the latest user message, or, when the last boundary is a finished
 * turn (an automatic turn, e.g. a background sub-agent reporting back), its first item.
 * `fallback` when neither is known.
 */
export function turnStart(items: readonly TimelineItem[], fallback: number): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user_message") return it.ts;
    if (it.kind === "turn_summary") return items[i + 1]?.ts ?? fallback;
  }
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

/** Statuses in which the "waiting on sub-agents" line may show (idle: the agent is just waiting too). */
export function waitingStatus(status: AgentStatus): boolean {
  return status === "working" || status === "starting" || status === "idle";
}

/** The indicator's text: starting, waiting on sub-agents, or a cycling verb. */
export function workingLabel(opts: { starting: boolean; name: string; subagents: number; verb: number; offset: number }): string {
  if (opts.starting) return `Starting ${opts.name}`;
  if (opts.subagents > 0) return waitingLabel(opts.subagents);
  return THINKING_VERBS[(opts.verb + opts.offset) % THINKING_VERBS.length];
}
