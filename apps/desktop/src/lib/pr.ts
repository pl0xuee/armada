// Pure helpers for the pull-request chip and its polling policy.
import type { Agent, PrCheck, PrInfo, PrStatus } from "./types";

export const PR_POLL_MS = 60_000;
/** Agents active within this window keep being polled even when not on screen. */
export const PR_ACTIVE_WINDOW_MS = 15 * 60_000;

export const PR_STATE_LABEL: Record<PrInfo["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

export const PR_REVIEW_LABEL: Record<NonNullable<PrInfo["review"]>, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
};

/** "2m 03s", "41s"; empty when unknown. */
export function formatDuration(secs: number | null): string {
  if (secs === null || secs < 0) return "";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function failingChecks(pr: PrInfo | null | undefined): PrCheck[] {
  return pr?.checks.filter((c) => c.status === "failing") ?? [];
}

/** Short, accessible description of the CI result. */
export function ciSummary(pr: PrInfo): string {
  const { failing, pending, passing, overall } = pr.summary;
  if (overall === "failing") return `${failing} check${failing === 1 ? "" : "s"} failing`;
  if (overall === "pending") return `${pending} check${pending === 1 ? "" : "s"} running`;
  if (overall === "passing") return `${passing} check${passing === 1 ? "" : "s"} passing`;
  return "No checks";
}

export function agentHasBranch(agent: Agent): boolean {
  return agent.branch !== null && agent.worktree;
}

/**
 * Which agents to poll now: the selected one, plus branch agents that are working
 * or were active recently (a PR may be waiting on them). Archived agents are skipped.
 */
export function agentsToPoll(agents: Agent[], selectedId: string | null, now: number): string[] {
  return agents
    .filter((a) => {
      if (!agentHasBranch(a) || a.archived) return false;
      if (a.id === selectedId) return true;
      const working = a.status === "working" || a.status === "starting" || a.status === "needs_permission";
      return working || now - a.lastActivityAt < PR_ACTIVE_WINDOW_MS;
    })
    .map((a) => a.id);
}

/** Whether a status is worth a list indicator (a PR exists and is not merged/closed noise). */
export function listIndicator(status: PrStatus | undefined): PrInfo | null {
  const pr = status?.state === "ok" ? status.pr : null;
  return pr && (pr.state === "open" || pr.state === "draft") ? pr : null;
}
