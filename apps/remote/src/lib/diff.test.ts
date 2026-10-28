import { describe, expect, it } from "vitest";
import { diffLines, parseFileDiff, parseUnified } from "./diff";

describe("diff", () => {
  it("computes a minimal line diff", () => {
    const ops = diffLines("a\nb\nc\nd\n", "a\nx\nc\nd\ne\n");
    expect(ops.map((o) => o.t[0] + o.text).join(",")).toBe("ea,db,ax,ec,ed,ae");
  });
  it("is fast on large files and collapses context", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const changed = big.slice();
    changed[1500] = "CHANGED";
    const t0 = performance.now();
    const r = parseFileDiff({ path: "x", oldText: big.join("\n"), newText: changed.join("\n"), unified: null })[0];
    expect(performance.now() - t0).toBeLessThan(200);
    expect([r.additions, r.deletions]).toEqual([1, 1]);
    expect(r.lines.length).toBeLessThan(12);
  });
  it("falls back instead of hanging on unrelated large files", () => {
    const t0 = performance.now();
    const r = parseFileDiff({
      path: "w",
      oldText: Array.from({ length: 5000 }, (_, i) => `a${i}`).join("\n"),
      newText: Array.from({ length: 5000 }, (_, i) => `b${i}`).join("\n"),
      unified: null,
    })[0];
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.truncated).toBe(true);
  });
  it("parses multi-file unified diffs", () => {
    const u = parseUnified(
      "diff --git a/x.ts b/x.ts\nindex 1..2\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@ fn\n-a\n+b\n c\ndiff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+hi\n",
      "fallback",
    );
    expect(u.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["x.ts", "modified", 1, 1],
      ["new.ts", "added", 1, 0],
    ]);
  });
  it("marks new files from full text", () => {
    expect(parseFileDiff({ path: "n", oldText: null, newText: "1\n2\n", unified: null })[0]).toMatchObject({ status: "added", additions: 2 });
  });
});
