import type { PrSnapshot } from "@/lib/types";

const summary = (passing: number, failing: number, pending: number) => ({
  passing,
  failing,
  pending,
  overall: failing ? "failing" : pending ? "pending" : passing ? "passing" : "none",
}) as const;

/** PR status for the mock's branch agents: a failing PR with changes requested, a green approved one, a draft, a merged one. */
export function mockPr(agentId: string): PrSnapshot {
  const at = Date.now();
  const pr = (number: number, state: "open" | "draft" | "merged", review: "approved" | "changes_requested" | "review_required" | null, s: ReturnType<typeof summary>) => ({
    state: "ok" as const,
    reason: null,
    fetchedAt: at,
    pr: { number, url: `https://github.com/acme/acme-api/pull/${number}`, title: "PR", state, review, mergeState: null, summary: s },
  });
  switch (agentId) {
    case "a1":
      return pr(1287, "open", "changes_requested", summary(9, 2, 0));
    case "a2":
      return pr(342, "open", "approved", summary(14, 0, 0));
    case "a5":
      return pr(7, "draft", null, summary(3, 0, 2));
    case "a12":
      return pr(1203, "merged", "approved", summary(12, 0, 0));
    case "a4":
      return { state: "unknown", reason: "gh_missing", pr: null, fetchedAt: at };
    default:
      return { state: "none", reason: null, pr: null, fetchedAt: at };
  }
}
