import { describe, expect, it } from "vitest";
import { hasBranch, prChip } from "./prChip";
import type { PhonePr, PrSnapshot } from "./types";

const snap = (pr: Partial<PhonePr> = {}, state: PrSnapshot["state"] = "ok"): PrSnapshot => ({
  state,
  reason: null,
  fetchedAt: 1,
  pr: {
    number: 42,
    url: "https://github.com/acme/web/pull/42",
    title: "Fix it",
    state: "open",
    review: null,
    mergeState: null,
    summary: { passing: 0, failing: 0, pending: 0, overall: "none" },
    ...pr,
  },
});

describe("prChip", () => {
  it("shows state, failing checks and the review", () => {
    const chip = prChip(snap({ review: "changes_requested", summary: { passing: 9, failing: 2, pending: 0, overall: "failing" } }))!;
    expect(chip.number).toBe("#42");
    expect(chip.state).toBe("Open");
    expect(chip.checks).toBe("2 failing");
    expect(chip.checksTone).toBe("err");
    expect(chip.review).toBe("Changes requested");
    expect(chip.reviewTone).toBe("err");
    expect(chip.url).toBe("https://github.com/acme/web/pull/42");
    expect(chip.label).toBe("Pull request 42, open, checks 2 failing, changes requested");
  });

  it("counts what is running, then what passes", () => {
    expect(prChip(snap({ summary: { passing: 3, failing: 0, pending: 2, overall: "pending" } }))!.checks).toBe("2 running");
    const green = prChip(snap({ review: "approved", summary: { passing: 14, failing: 0, pending: 0, overall: "passing" } }))!;
    expect(green.checks).toBe("14 passing");
    expect(green.checksTone).toBe("ok");
    expect(green.review).toBe("Approved");
    expect(green.reviewTone).toBe("ok");
    expect(prChip(snap({ review: "review_required" }))!.reviewTone).toBe("warn");
  });

  it("has no checks to report without any", () => {
    expect(prChip(snap())!.checks).toBeNull();
  });

  it("leaves checks and review off a PR that is over", () => {
    const merged = prChip(snap({ state: "merged", review: "approved", summary: { passing: 12, failing: 0, pending: 0, overall: "passing" } }))!;
    expect(merged.state).toBe("Merged");
    expect(merged.checks).toBeNull();
    expect(merged.review).toBeNull();
    expect(prChip(snap({ state: "draft" }))!.state).toBe("Draft");
  });

  it("opens only web links", () => {
    expect(prChip(snap({ url: null }))!.url).toBeNull();
    expect(prChip(snap({ url: "javascript:alert(1)" }))!.url).toBeNull();
    expect(prChip(snap({ url: "http://ghe.local/pull/1" }))!.url).toBe("http://ghe.local/pull/1");
  });

  it("is nothing without a PR, or when GitHub couldn't be asked", () => {
    expect(prChip(undefined)).toBeNull();
    expect(prChip({ state: "none", reason: null, pr: null, fetchedAt: 1 })).toBeNull();
    expect(prChip({ state: "unknown", reason: "gh_missing", pr: null, fetchedAt: 1 })).toBeNull();
  });
});

describe("hasBranch", () => {
  it("is for agents on their own branch", () => {
    expect(hasBranch({ branch: "kvistcode/x", worktree: true })).toBe(true);
    expect(hasBranch({ branch: null, worktree: false })).toBe(false);
    expect(hasBranch({ branch: "main", worktree: false })).toBe(false);
  });
});
