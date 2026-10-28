// Presentation of git operation results (commit / ship / PR) shared by the Review sheet and
// the turn-summary card, plus the "agent is busy" gate for git actions.
import { toast } from "sonner";
import { openExternal } from "./external";
import type { Agent, CommitSummary, ShipResult } from "./types";

/** Why git actions are unavailable right now (null when they're allowed). */
export function gitBusyReason(agent: Agent): string | null {
  if (agent.status === "working" || agent.status === "starting") {
    return "The agent is still working; stop it or wait before committing, merging or reverting";
  }
  if (agent.status === "needs_permission") {
    return "The agent is waiting for an approval; answer it or stop the turn first";
  }
  return null;
}

/** Commit result toast: success, or a warning when files were left uncommitted or skipped. */
export function toastCommit(summary: CommitSummary) {
  const partial = summary.leftUncommitted > 0 || summary.skipped.length > 0;
  const skipped = summary.skipped.length ? `Skipped: ${summary.skipped.join(", ")}` : undefined;
  if (partial) toast.warning(summary.message, { description: skipped, duration: 8000 });
  else toast.success(summary.message, { description: skipped });
}

export type ShipOutcome =
  | { kind: "shipped"; committed: string | null; merged: string | null }
  | { kind: "committed_not_merged"; committed: string | null; error: string; conflict: boolean };

export function shipOutcome(r: ShipResult): ShipOutcome {
  if (r.error)
    return { kind: "committed_not_merged", committed: r.committed, error: r.error, conflict: isConflict(r.error) };
  return { kind: "shipped", committed: r.committed, merged: r.merged };
}

export function isConflict(message: string): boolean {
  return /conflict/i.test(message);
}

/** create_pr resolves to a URL, or "A pull request already exists: <url>". */
export function prResult(result: string): { url: string; existed: boolean } {
  const existed = /^A pull request already exists/i.test(result.trim());
  const tokens = result.trim().split(/\s+/);
  return { url: existed ? (tokens[tokens.length - 1] ?? result) : result.trim(), existed };
}

export function toastPr(result: string) {
  const { url, existed } = prResult(result);
  const action = { label: "Open", onClick: () => void openExternal(url) };
  if (existed) toast.info("A pull request already exists", { description: url, action });
  else toast.success("Pull request opened", { description: url, action });
}

/** Prompt asking the agent to resolve a failed merge. */
export function conflictPrompt(agent: Agent, error: string): string {
  const base = agent.baseBranch ?? "the base branch";
  return `Merging ${agent.branch ?? "your branch"} into ${base} failed:\n\n${error}\n\nPlease merge ${base} into your branch, resolve the conflicts, make sure everything still builds and tests pass, and commit the result.`;
}
