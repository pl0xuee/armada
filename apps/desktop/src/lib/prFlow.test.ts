import { describe, expect, it } from "vitest";
import {
  agentIssueNumber,
  commentsLabel,
  filterIssues,
  issueLabels,
  labelInk,
  mergeAdvice,
  mergeFacts,
  needsServerSearch,
  prefillPr,
  readiness,
  shortSha,
} from "./prFlow";
import type { IssueSummary, PrInfo } from "./types";

const pr = (over: Partial<PrInfo> = {}, summary: Partial<PrInfo["summary"]> = {}): PrInfo => ({
  number: 7,
  url: "u",
  title: "t",
  state: "open",
  review: null,
  mergeable: "mergeable",
  checks: [],
  summary: { passing: 1, failing: 0, pending: 0, overall: "passing", ...summary },
  ...over,
});

const issue = (number: number, title: string, labels: string[] = [], author: string | null = null): IssueSummary => ({
  number,
  title,
  url: `https://github.com/o/r/issues/${number}`,
  author,
  labels: labels.map((name) => ({ name, color: "d73a4a" })),
  updatedAt: "2026-10-30T10:00:00Z",
});

describe("issue agents", () => {
  it("finds the issue from the branch kvistcode made", () => {
    expect(agentIssueNumber({ worktree: true, branch: "kvistcode/issue-42-fix-login-crash-ab12cd34" })).toBe(42);
    expect(agentIssueNumber({ worktree: true, branch: "kvistcode/issue-7-ab12cd34" })).toBe(7);
    expect(agentIssueNumber({ worktree: true, branch: "kvistcode/issue-7" })).toBe(7);
    expect(agentIssueNumber({ worktree: true, branch: "kvistcode/issues-fix-ab12cd34" })).toBeNull();
    expect(agentIssueNumber({ worktree: true, branch: "kvistcode/fix-issue-42-ab12cd34" })).toBeNull();
    expect(agentIssueNumber({ worktree: false, branch: "kvistcode/issue-42-x" })).toBeNull();
    expect(agentIssueNumber({ worktree: true, branch: null })).toBeNull();
  });
});

describe("prefillPr", () => {
  const files = [
    { additions: 10, deletions: 2 },
    { additions: 5, deletions: 0 },
  ];
  it("uses the summary, the size of the change and the issue", () => {
    const out = prefillPr(
      { title: "Issue #42: Login crashes", lastMessage: "Fixed it.", branch: "kvistcode/issue-42-login-ab12cd34", worktree: true },
      files,
    );
    expect(out.title).toBe("Login crashes");
    expect(out.body).toBe("## Summary\n\nFixed it.\n\n2 files changed, +15 −2\n\nCloses #42\n\n_Opened from Kvistcode._");
  });
  it("is plain without an issue, a summary or a diff", () => {
    const out = prefillPr({ title: "Tidy", lastMessage: null, branch: "kvistcode/tidy-ab12cd34", worktree: true });
    expect(out).toEqual({ title: "Tidy", body: "" });
    expect(prefillPr({ title: "Tidy", lastMessage: "  ", branch: "b", worktree: true }, [files[0]]).body).toContain(
      "1 file changed",
    );
  });
  it("cuts very long summaries", () => {
    const out = prefillPr({ title: "T", lastMessage: "x".repeat(9000), branch: "b", worktree: true });
    expect(out.body.length).toBeLessThan(4200);
    expect(out.body).toContain("…");
  });
});

describe("merge advice", () => {
  it("is clean for a green, approved, mergeable PR", () => {
    expect(mergeAdvice(pr({ review: "approved" }))).toEqual({ canMerge: true, cautions: [] });
    expect(readiness(pr({ review: "approved" })).text).toBe("Ready to merge");
  });
  it("lists what to look at, worst first", () => {
    const a = mergeAdvice(
      pr({ mergeable: "conflicting", review: "changes_requested", unresolvedThreads: 2 }, { failing: 2, overall: "failing" }),
    );
    expect(a.cautions).toEqual([
      "It has merge conflicts with the base branch.",
      "2 checks are failing.",
      "A reviewer asked for changes.",
      "2 review threads are unresolved.",
    ]);
    expect(mergeAdvice(pr({}, { pending: 1, overall: "pending" })).cautions).toEqual(["1 check is still running."]);
  });
  it("explains a block GitHub doesn't give a reason for", () => {
    expect(mergeAdvice(pr({ mergeState: "blocked" })).cautions).toHaveLength(1);
    expect(mergeAdvice(pr({ mergeState: "blocked", review: "review_required" })).cautions).toEqual([
      "It still needs an approving review.",
    ]);
  });
  it("cannot merge drafts or finished PRs", () => {
    expect(mergeAdvice(pr({ state: "draft" })).canMerge).toBe(false);
    expect(mergeAdvice(pr({ state: "merged" })).canMerge).toBe(false);
    expect(readiness(pr({ state: "draft" })).text).toBe("Draft");
  });
  it("ranks readiness: conflicts, failing, changes, running, comments", () => {
    expect(readiness(pr({ mergeable: "conflicting" }, { failing: 1 })).text).toBe("Has conflicts");
    expect(readiness(pr({}, { failing: 1, overall: "failing" })).tone).toBe("err");
    expect(readiness(pr({ review: "changes_requested" })).text).toBe("Changes requested");
    expect(readiness(pr({}, { pending: 1, overall: "pending" })).text).toBe("Checks running");
    expect(readiness(pr({ unresolvedThreads: 3 })).text).toBe("Unresolved comments");
  });
  it("names the open comments on the button", () => {
    expect(commentsLabel(pr())).toBe("Address comments");
    expect(commentsLabel(pr({ unresolvedThreads: 1 }))).toBe("Address 1 comment");
    expect(commentsLabel(pr({ unresolvedThreads: 4 }))).toBe("Address 4 comments");
  });
});

describe("issue list", () => {
  const issues = [
    issue(42, "Login crashes on empty password", ["bug", "auth"], "maria"),
    issue(7, "Docs typo in README", ["docs"]),
    issue(420, "Add dark mode", ["enhancement"], "sam"),
  ];
  it("searches title, number, author and label", () => {
    expect(filterIssues(issues, "", null)).toHaveLength(3);
    expect(filterIssues(issues, "LOGIN", null).map((i) => i.number)).toEqual([42]);
    expect(filterIssues(issues, "#42", null).map((i) => i.number)).toEqual([42, 420]);
    expect(filterIssues(issues, "maria", null).map((i) => i.number)).toEqual([42]);
    expect(filterIssues(issues, "docs", null).map((i) => i.number)).toEqual([7]);
    expect(filterIssues(issues, "zzz", null)).toEqual([]);
  });
  it("narrows by label chip together with the search", () => {
    expect(filterIssues(issues, "", "bug").map((i) => i.number)).toEqual([42]);
    expect(filterIssues(issues, "docs", "bug")).toEqual([]);
  });
  it("lists labels by use", () => {
    const withMore = [...issues, issue(9, "Another", ["docs"])];
    expect(issueLabels(withMore).map((l) => l.name)).toEqual(["docs", "auth", "bug", "enhancement"]);
  });
  it("asks GitHub only when the list is partial", () => {
    expect(needsServerSearch({ issues, truncated: true }, "login")).toBe(true);
    expect(needsServerSearch({ issues, truncated: true }, "l")).toBe(false);
    expect(needsServerSearch({ issues, truncated: false }, "login")).toBe(false);
    expect(needsServerSearch(null, "login")).toBe(false);
  });
  it("picks readable label text", () => {
    expect(labelInk("ffffff")).toBe("dark");
    expect(labelInk("d73a4a")).toBe("light");
    expect(labelInk("")).toBe("light");
  });
});

describe("merge dialog honesty", () => {
  it("never calls pending or unknown things fine", () => {
    // Pending alongside failing: both are listed.
    expect(mergeAdvice(pr({}, { failing: 1, pending: 2, overall: "failing" })).cautions).toEqual([
      "1 check is failing.",
      "2 checks are still running.",
    ]);
    // GitHub hasn't answered about conflicts yet.
    expect(mergeAdvice(pr({ mergeable: null })).cautions).toEqual(["GitHub hasn't finished checking for merge conflicts."]);
    expect(readiness(pr({ mergeable: null })).text).toBe("Merge status unknown");
    expect(readiness(pr({ mergeable: null })).tone).toBe("muted");
    // GitHub's own "clean" verdict is enough to call it ready.
    expect(readiness(pr({ mergeable: null, mergeState: "clean" })).text).toBe("Ready to merge");
    expect(readiness(pr({ mergeState: "behind" })).text).toBe("Behind the base branch");
  });
  it("lists the facts, saying 'not known' when it isn't", () => {
    const facts = (over: Partial<PrInfo>, s: Partial<PrInfo["summary"]> = {}) =>
      Object.fromEntries(mergeFacts(pr(over, s)).map((f) => [f.key, `${f.tone}:${f.text}`]));
    expect(facts({ review: "approved", unresolvedThreads: 0 }, { passing: 3 })).toEqual({
      checks: "ok:Checks: 3 passing",
      conflicts: "ok:No conflicts",
      review: "ok:Approved",
      comments: "ok:No unresolved threads",
    });
    expect(facts({ mergeable: null }, { passing: 1, pending: 2, failing: 1, overall: "failing" })).toMatchObject({
      checks: "err:Checks: 1 failing, 2 running, 1 passing",
      conflicts: "muted:Conflicts: not known yet",
      review: "muted:No review decision",
      comments: "muted:Review comments: not checked",
    });
    // Running checks are a warning, never "passing".
    expect(facts({}, { passing: 0, pending: 1, overall: "pending" }).checks).toBe("warn:Checks: 1 running");
    expect(facts({}, { passing: 0, overall: "none" }).checks).toBe("muted:Checks: none reported");
    expect(facts({ unresolvedThreads: 2 }).comments).toBe("warn:2 unresolved threads");
  });
  it("shortens a commit id", () => {
    expect(shortSha("3f2a9c1d5e7b4a6c8d0e1f2a3b4c5d6e7f8a9b0c")).toBe("3f2a9c1");
    expect(shortSha(null)).toBe("");
  });
});
