// Pure rules behind the pinned dock above the composer: which items it shows and in what order, how a
// plan's progress and its "just finished" linger are derived, the quick-answer number keys, and the
// reset time of a usage limit. No React here, so all of it is unit-tested.
import { budgetLevel } from "./budget";
import type { Agent, PlanEntry, TimelineItem } from "./types";

// ---------------------------------------------------------------- plan

/** How long a finished plan stays pinned, with a check, before it folds away. */
export const PLAN_LINGER_MS = 4000;
/** From this many steps a running plan starts collapsed to its current step. */
export const PLAN_COLLAPSE_AT = 4;

export interface PlanProgress {
  total: number;
  done: number;
  /** The step being worked on: the in-progress one, else the first pending one. */
  current: PlanEntry | null;
  /** Position of `current` in the plan (0-based), or -1. */
  currentIndex: number;
  /** Every step is completed (and there is at least one). */
  complete: boolean;
}

export function planProgress(entries: readonly PlanEntry[]): PlanProgress {
  let done = 0;
  let currentIndex = -1;
  let pendingIndex = -1;
  entries.forEach((e, i) => {
    if (e.status === "completed") done++;
    else if (e.status === "in_progress" && currentIndex < 0) currentIndex = i;
    else if (e.status === "pending" && pendingIndex < 0) pendingIndex = i;
  });
  if (currentIndex < 0) currentIndex = pendingIndex;
  return {
    total: entries.length,
    done,
    current: currentIndex >= 0 ? entries[currentIndex] : null,
    currentIndex,
    complete: entries.length > 0 && done === entries.length,
  };
}

export type PlanPhase = "active" | "done";

/**
 * Whether and how the plan is pinned. `live`: the plan belongs to the current turn; `busy`: the agent
 * is working. An unfinished plan is pinned only while it is live and the agent works (an abandoned one
 * is just history); a finished one only while it `lingering`.
 */
export function planPhase(
  progress: PlanProgress | null,
  state: { live: boolean; busy: boolean; lingering: boolean },
): PlanPhase | null {
  if (!progress || progress.total === 0) return null;
  if (progress.complete) return state.lingering ? "done" : null;
  return state.live && state.busy ? "active" : null;
}

/** The linger starts when a pinned plan stops being active because every step is done. */
export function lingerStarts(wasActive: boolean, phase: PlanPhase | null, progress: PlanProgress | null): boolean {
  return wasActive && phase !== "active" && Boolean(progress?.complete);
}

/** Collapsed by default for a long plan that is still being worked on; the user's choice wins. */
export function planStartsOpen(total: number, saved: boolean | undefined): boolean {
  return saved ?? total < PLAN_COLLAPSE_AT;
}

/**
 * Whether the latest plan belongs to the current turn: it comes after the last real user message
 * (a message typed into a running turn, `midTurn`, doesn't start a new one).
 */
export function planIsLive(items: readonly TimelineItem[]): boolean {
  let planAt = -1;
  let userAt = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "plan") planAt = i;
    else if (it.kind === "user_message" && !it.midTurn) userAt = i;
  }
  return planAt >= 0 && planAt > userAt;
}

// ---------------------------------------------------------------- what the dock shows

export type DockSection =
  "needs_you" | "rate_limit" | "error" | "budget" | "conflict" | "plan" | "workflow" | "subagents" | "queue";

export type DockFlags = Record<DockSection, boolean>;

/** Most important first: what waits for you, what blocks the agent, then what is just in progress. */
export const DOCK_ORDER: readonly DockSection[] = [
  "needs_you",
  "rate_limit",
  "error",
  "budget",
  "conflict",
  "plan",
  "workflow",
  "subagents",
  "queue",
];

export function dockSections(flags: Partial<DockFlags>): DockSection[] {
  return DOCK_ORDER.filter((s) => flags[s]);
}

/** The blockers of an agent (not the approval or question it waits on). */
export interface Blockers {
  rateLimit: boolean;
  error: boolean;
  budget: boolean;
  conflict: boolean;
}

type AgentLike = Pick<Agent, "status" | "rateLimited" | "costUsd" | "helperSync" | "parentId">;

/**
 * What is stopping the agent from going on, and can be acted on from the dock:
 * - the account hit its usage limit (switch account / retry);
 * - the turn failed (retry);
 * - the per-agent budget was reached and the setting pauses agents (raise it);
 * - a helper's merge is stuck (sync / ask the main agent).
 * A shut-down or interrupted agent shows the Resume banner instead of the composer, so nothing here.
 */
export function blockers(
  agent: AgentLike,
  settings: { agentBudgetUsd: number | null | undefined; budgetAction: string | undefined },
): Blockers {
  const resumable = agent.status === "interrupted" || agent.status === "stopped";
  const working = agent.status === "working" || agent.status === "starting";
  return {
    rateLimit: agent.rateLimited && !resumable,
    error: agent.status === "error" && !agent.rateLimited,
    budget:
      !resumable &&
      !working &&
      settings.budgetAction === "pause" &&
      budgetLevel(agent.costUsd, settings.agentBudgetUsd) === "hit",
    conflict: Boolean(agent.parentId) && agent.helperSync?.state === "conflict",
  };
}

export type NeedsYouKind = "approval" | "plan_approval" | "question";

export function needsYouKind(item: TimelineItem | null): NeedsYouKind | null {
  if (!item) return null;
  if (item.kind === "question") return "question";
  if (item.kind === "permission") return item.plan ? "plan_approval" : "approval";
  return null;
}

/** The newest unanswered approval, else the newest unanswered question (an approval acts first). */
export function latestNeedsYou(items: readonly TimelineItem[] | undefined): TimelineItem | null {
  if (!items) return null;
  let question: TimelineItem | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "permission" && it.resolution === null) return it;
    if (!question && it.kind === "question" && it.resolution === null) question = it;
  }
  return question;
}

// ---------------------------------------------------------------- quick answers

/** "1".."9" -> 0..8 when there is such a row among `count`; anything else (or a modified key) -> null. */
export function quickKeyIndex(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">,
  count: number,
): number | null {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return null;
  const i = Number(e.key) - 1;
  return i < count ? i : null;
}

// ---------------------------------------------------------------- usage limit

const RESET = /\bresets?\s+(?:(at|in|on|around|after)\s+)?([^.;\n]{1,40})/i;

/**
 * The "resets at 6:00 PM" part of a provider's usage-limit message, tidied for a label
 * ("Resets at 6:00 PM"); null when the message names no reset time.
 */
export function resetClause(text: string | null | undefined): string | null {
  const m = text ? RESET.exec(text) : null;
  if (!m) return null;
  const rest = m[2].trim().replace(/[)\s]+$/, "");
  if (!rest) return null;
  return m[1] ? `Resets ${m[1].toLowerCase()} ${rest}` : `Resets ${rest}`;
}

/** The message without its reset clause (the dock shows that one separately). */
export function withoutReset(text: string): string {
  return text
    .replace(new RegExp(`\\s*${RESET.source}\\.?`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
}
