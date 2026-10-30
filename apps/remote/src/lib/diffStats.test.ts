import { describe, expect, it } from "vitest";
import { cheapStats, cheapStatsAll } from "./diffStats";

describe("cheapStats", () => {
  it("counts a unified diff exactly, ignoring file headers", () => {
    const unified = "--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n";
    expect(cheapStats({ path: "f", oldText: null, newText: null, unified })).toEqual({ additions: 2, deletions: 1 });
  });
  it("compares old and new texts as line multisets", () => {
    expect(cheapStats({ path: "f", oldText: "a\nb\nc\n", newText: "a\nc\nd\ne\n", unified: null })).toEqual({ additions: 2, deletions: 1 });
    expect(cheapStats({ path: "f", oldText: null, newText: "x\ny", unified: null })).toEqual({ additions: 2, deletions: 0 });
  });
  it("sums several files", () => {
    const d = { path: "f", oldText: "a", newText: "b", unified: null };
    expect(cheapStatsAll([d, d])).toEqual({ additions: 2, deletions: 2 });
  });
});
