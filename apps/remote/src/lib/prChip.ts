/** What the agent screen's PR chip says (pure; the component is `components/PrChip`). */
import { PR_REVIEW_LABEL, PR_STATE_LABEL } from "@shared/pr";
import type { Agent, PhonePr, PrSnapshot } from "./types";

/** How often an open agent screen asks again, as on the desktop. */
export const PR_POLL_MS = 60_000;

/** Only an agent on its own branch can have a PR (the desktop's `agentHasBranch`). */
export function hasBranch(agent: Pick<Agent, "branch" | "worktree">): boolean {
  return !!agent.branch && agent.worktree === true;
}

export type PrTone = "ok" | "warn" | "err" | "accent" | "muted";

export interface PrChipModel {
  /** "#42" */
  number: string;
  /** "Open", "Draft", "Merged", "Closed" */
  state: string;
  /** "3 failing", "2 running", "12 passing"; null with no checks. */
  checks: string | null;
  checksTone: PrTone;
  /** "Approved", "Changes requested", "Review required"; null once merged or closed. */
  review: string | null;
  reviewTone: PrTone;
  /** A web link to the PR, if there is one to open. */
  url: string | null;
  /** The whole chip in one sentence, for screen readers. */
  label: string;
}

const CHECKS_TONE: Record<PhonePr["summary"]["overall"], PrTone> = { failing: "err", pending: "warn", passing: "ok", none: "muted" };

function checksText(pr: PhonePr): string | null {
  const { failing, pending, passing, overall } = pr.summary;
  if (overall === "failing") return `${failing} failing`;
  if (overall === "pending") return `${pending} running`;
  if (overall === "passing") return `${passing} passing`;
  return null;
}

/** The chip for a status, or null when there is no PR to show (none, or GitHub couldn't be asked). */
export function prChip(snap: PrSnapshot | undefined): PrChipModel | null {
  const pr = snap?.state === "ok" ? snap.pr : null;
  if (!pr) return null;
  const live = pr.state === "open" || pr.state === "draft";
  const review = live && pr.review ? PR_REVIEW_LABEL[pr.review] : null;
  const checks = live ? checksText(pr) : null;
  const state = PR_STATE_LABEL[pr.state];
  const parts = [`Pull request ${pr.number}`, state.toLowerCase(), checks && `checks ${checks}`, review && review.toLowerCase()].filter(Boolean);
  return {
    number: `#${pr.number}`,
    state,
    checks,
    checksTone: CHECKS_TONE[pr.summary.overall] ?? "muted",
    review,
    reviewTone: pr.review === "approved" ? "ok" : pr.review === "changes_requested" ? "err" : "warn",
    url: pr.url && /^https?:\/\//i.test(pr.url) ? pr.url : null,
    label: parts.join(", "),
  };
}
