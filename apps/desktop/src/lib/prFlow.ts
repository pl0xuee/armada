// Pure helpers for the issue -> agent -> pull request -> merge loop (PR form, merge panel, issue list).
import type { Agent, ChangedFile, IssueLabel, IssueList, IssueSummary, MergeMethod, PrInfo } from "./types";

/** Agents started from an issue are titled "Issue #42: …", which puts `issue-42-` at the front of their branch. */
const ISSUE_BRANCH = /^kvistcode\/issue-(\d+)(?:-|$)/;
const ISSUE_TITLE_PREFIX = /^Issue #\d+:\s*/;

/** The issue an agent was started on, from its branch name (no extra state to keep in sync). */
export function agentIssueNumber(agent: Pick<Agent, "branch" | "worktree">): number | null {
  if (!agent.worktree || !agent.branch) return null;
  const m = ISSUE_BRANCH.exec(agent.branch);
  return m ? Number(m[1]) : null;
}

const MAX_SUMMARY_CHARS = 4000;

/** Title and description a new pull request starts from: the agent's last summary, the size of the change, and "Closes #N". */
export function prefillPr(
  agent: Pick<Agent, "title" | "lastMessage" | "branch" | "worktree">,
  files: Pick<ChangedFile, "additions" | "deletions">[] | null = null,
): { title: string; body: string } {
  const issue = agentIssueNumber(agent);
  const title = (issue ? agent.title.replace(ISSUE_TITLE_PREFIX, "") : agent.title).trim() || agent.title;
  const parts: string[] = [];
  const summary = agent.lastMessage?.trim();
  if (summary) {
    parts.push(
      `## Summary\n\n${summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS).trimEnd()}…` : summary}`,
    );
  }
  if (files && files.length > 0) {
    const add = files.reduce((n, f) => n + f.additions, 0);
    const del = files.reduce((n, f) => n + f.deletions, 0);
    parts.push(`${files.length} ${files.length === 1 ? "file" : "files"} changed, +${add} −${del}`);
  }
  if (issue) parts.push(`Closes #${issue}`);
  if (parts.length > 0) parts.push("_Opened from Kvistcode._");
  return { title, body: parts.join("\n\n") };
}

export const MERGE_METHODS: { value: MergeMethod; label: string; hint: string }[] = [
  { value: "squash", label: "Squash and merge", hint: "One commit on the base branch" },
  { value: "merge", label: "Create a merge commit", hint: "Keeps every commit, adds a merge commit" },
  { value: "rebase", label: "Rebase and merge", hint: "Replays the commits onto the base branch" },
];

const MERGE_METHOD_KEY = "armada.mergeMethod";

export function readMergeMethod(): MergeMethod {
  try {
    const v = localStorage.getItem(MERGE_METHOD_KEY);
    return v === "merge" || v === "rebase" || v === "squash" ? v : "squash";
  } catch {
    return "squash";
  }
}

export function rememberMergeMethod(m: MergeMethod) {
  try {
    localStorage.setItem(MERGE_METHOD_KEY, m);
  } catch {
    /* private mode: the choice just isn't kept */
  }
}

export interface MergeAdvice {
  /** Merging is possible at all (the PR is open, not a draft). */
  canMerge: boolean;
  /** Things worth a second look before confirming, most important first. */
  cautions: string[];
}

/** What to tell someone about to merge `pr`. GitHub has the last word; these are heads-ups, not gates. */
export function mergeAdvice(pr: PrInfo): MergeAdvice {
  const cautions: string[] = [];
  const { failing, pending } = pr.summary;
  if (pr.mergeable === "conflicting") cautions.push("It has merge conflicts with the base branch.");
  else if (pr.mergeable === null && pr.state === "open")
    cautions.push("GitHub hasn't finished checking for merge conflicts.");
  if (failing > 0) cautions.push(`${failing} ${failing === 1 ? "check is" : "checks are"} failing.`);
  if (pending > 0) cautions.push(`${pending} ${pending === 1 ? "check is" : "checks are"} still running.`);
  if (pr.review === "changes_requested") cautions.push("A reviewer asked for changes.");
  else if (pr.review === "review_required") cautions.push("It still needs an approving review.");
  const open = pr.unresolvedThreads ?? 0;
  if (open > 0) cautions.push(`${open} review ${open === 1 ? "thread is" : "threads are"} unresolved.`);
  if (pr.mergeState === "behind") cautions.push("The branch is behind the base branch.");
  if (pr.mergeState === "blocked" && cautions.length === 0) cautions.push("GitHub is blocking this merge (a required check or review).");
  return { canMerge: pr.state === "open", cautions };
}

export interface MergeFact {
  key: "checks" | "conflicts" | "review" | "comments";
  tone: "ok" | "warn" | "err" | "muted";
  text: string;
}

/**
 * What is known about `pr` right now, one line per thing, for the merge panel. Says "not known"
 * rather than "fine" whenever GitHub hasn't answered, and never calls pending checks passing.
 */
export function mergeFacts(pr: PrInfo): MergeFact[] {
  const { passing, failing, pending } = pr.summary;
  const parts = [
    failing > 0 && `${failing} failing`,
    pending > 0 && `${pending} running`,
    passing > 0 && `${passing} passing`,
  ].filter(Boolean);
  const checks: MergeFact = {
    key: "checks",
    tone: failing > 0 ? "err" : pending > 0 ? "warn" : passing > 0 ? "ok" : "muted",
    text: parts.length > 0 ? `Checks: ${parts.join(", ")}` : "Checks: none reported",
  };
  const conflicts: MergeFact =
    pr.mergeable === "conflicting"
      ? { key: "conflicts", tone: "err", text: "Conflicts with the base branch" }
      : pr.mergeable === "mergeable"
        ? { key: "conflicts", tone: "ok", text: "No conflicts" }
        : { key: "conflicts", tone: "muted", text: "Conflicts: not known yet" };
  const reviews: Record<NonNullable<PrInfo["review"]>, Pick<MergeFact, "tone" | "text">> = {
    approved: { tone: "ok", text: "Approved" },
    changes_requested: { tone: "warn", text: "Changes requested" },
    review_required: { tone: "warn", text: "Review required" },
  };
  const review: MergeFact = { key: "review", ...(pr.review ? reviews[pr.review] : { tone: "muted", text: "No review decision" }) };
  const n = pr.unresolvedThreads;
  const comments: MergeFact =
    n == null
      ? { key: "comments", tone: "muted", text: "Review comments: not checked" }
      : n > 0
        ? { key: "comments", tone: "warn", text: `${n} unresolved ${n === 1 ? "thread" : "threads"}` }
        : { key: "comments", tone: "ok", text: "No unresolved threads" };
  return [checks, conflicts, review, comments];
}

/** The first seven characters of a commit id, as git shows it. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

/** A pull request's one-line readiness for the panel: "Ready to merge", "Checks failing", … */
export function readiness(pr: PrInfo): { tone: "ok" | "warn" | "err" | "muted"; text: string } {
  if (pr.state === "merged") return { tone: "muted", text: "Merged" };
  if (pr.state === "closed") return { tone: "muted", text: "Closed" };
  if (pr.state === "draft") return { tone: "muted", text: "Draft" };
  if (pr.mergeable === "conflicting") return { tone: "err", text: "Has conflicts" };
  if (pr.summary.failing > 0) return { tone: "err", text: "Checks failing" };
  if (pr.review === "changes_requested") return { tone: "warn", text: "Changes requested" };
  if (pr.summary.pending > 0) return { tone: "warn", text: "Checks running" };
  if ((pr.unresolvedThreads ?? 0) > 0) return { tone: "warn", text: "Unresolved comments" };
  if (pr.mergeState === "blocked" || pr.review === "review_required") return { tone: "warn", text: "Waiting on review" };
  if (pr.mergeState === "behind") return { tone: "warn", text: "Behind the base branch" };
  // "Ready" only when GitHub said so: an unanswered mergeability check is not a yes.
  if (pr.mergeable === null && pr.mergeState !== "clean") return { tone: "muted", text: "Merge status unknown" };
  return { tone: "ok", text: "Ready to merge" };
}

/** The label to show on the "address comments" button: names the open threads when known. */
export function commentsLabel(pr: PrInfo): string {
  const n = pr.unresolvedThreads ?? 0;
  return n > 0 ? `Address ${n} ${n === 1 ? "comment" : "comments"}` : "Address comments";
}

// ---- issues

/** Issues matching the search text (title, "#number", author, label) and, when set, carrying `label`. */
export function filterIssues(issues: IssueSummary[], query: string, label: string | null): IssueSummary[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  return issues.filter((i) => {
    if (label && !i.labels.some((l) => l.name === label)) return false;
    if (!q) return true;
    return (
      String(i.number).startsWith(q) ||
      i.title.toLowerCase().includes(q) ||
      (i.author?.toLowerCase().includes(q) ?? false) ||
      i.labels.some((l) => l.name.toLowerCase().includes(q))
    );
  });
}

/** The labels in use, most common first (ties alphabetical), as chips. */
export function issueLabels(issues: IssueSummary[]): IssueLabel[] {
  const counts = new Map<string, { label: IssueLabel; n: number }>();
  for (const i of issues)
    for (const l of i.labels) {
      const hit = counts.get(l.name);
      if (hit) hit.n += 1;
      else counts.set(l.name, { label: l, n: 1 });
    }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.label.name.localeCompare(b.label.name))
    .map((x) => x.label);
}

/** Whether typing should ask GitHub (the list was cut short, so a local filter can miss issues). */
export function needsServerSearch(list: IssueList | null, query: string): boolean {
  return !!list?.truncated && query.trim().length >= 2;
}

/** Readable text colour for a label chip drawn on its hex background. */
export function labelInk(hex: string): "dark" | "light" {
  const m = /^[0-9a-f]{6}$/i.exec(hex);
  if (!m) return "light";
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "dark" : "light";
}
