import { describe, expect, it } from "vitest";
import { PatchIndex } from "./patchIndex";
import { slicePatch } from "./patchSlices";

const text = (path: string, body = "-old\n+new\n") =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;
const bin = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\nBinary files a/${path} and b/${path} differ\n`;

describe("PatchIndex", () => {
  const patch = text("a.ts") + bin("img/logo.png") + text("dir/b c.ts", "-x\n+y\n+z\n");
  const idx = new PatchIndex(patch);

  it("finds every file section without parsing hunks", () => {
    expect(idx.sections.map((s) => s.path)).toEqual(["a.ts", "img/logo.png", "dir/b c.ts"]);
    expect(idx.isBinary("img/logo.png")).toBe(true);
    expect(idx.isBinary("a.ts")).toBe(false);
    expect(idx.has("nope")).toBe(false);
  });

  it("cuts exact raw sections that match a full slicePatch", () => {
    const full = slicePatch(patch);
    for (const f of full) expect(idx.text(f.path)).toBe(f.text);
    expect(idx.slice("dir/b c.ts")?.hunks).toHaveLength(1);
  });

  it("parses one file lazily and memoises it", () => {
    const p = idx.parsed("dir/b c.ts")!;
    expect(p.additions).toBe(2);
    expect(p.deletions).toBe(1);
    expect(idx.parsed("dir/b c.ts")).toBe(p);
    expect(idx.parsed("img/logo.png")?.binary).toBe(true);
    expect(idx.parsed("missing")).toBeNull();
  });

  it("does not mistake a body line that looks like a header for a new file", () => {
    const sneaky = text("x.txt", " ctx\n+diff --git a/fake b/fake\n-diff --git a/fake2 b/fake2\n");
    const i = new PatchIndex(sneaky + text("y.txt"));
    expect(i.sections.map((s) => s.path)).toEqual(["x.txt", "y.txt"]);
  });

  it("handles quoted paths and renames", () => {
    const p =
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n' +
      "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n";
    const i = new PatchIndex(p);
    expect(i.sections.map((s) => s.path)).toEqual(["café.txt", "new.ts"]);
    expect(i.parsed("new.ts")?.oldPath).toBe("old.ts");
  });

  it("falls back to eager slicing for plain unified diffs", () => {
    const plain = "--- a/p.txt\n+++ b/p.txt\n@@ -1 +1 @@\n-a\n+b\n";
    const i = new PatchIndex(plain);
    expect(i.sections.map((s) => s.path)).toEqual(["p.txt"]);
    expect(i.parsed("p.txt")?.additions).toBe(1);
  });

  it("indexes thousands of files quickly", () => {
    const big = Array.from({ length: 4000 }, (_, i) => bin(`assets/f${i}.bin`)).join("");
    const t = performance.now();
    const i = new PatchIndex(big);
    expect(i.sections).toHaveLength(4000);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it("copes with an empty patch", () => {
    expect(new PatchIndex("").sections).toEqual([]);
  });
});

describe("PatchIndex odd paths", () => {
  it("finds renames, spaces, unicode and CRLF bodies", () => {
    const p =
      "diff --git a/old name.txt b/new üname.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new üname.txt\n" +
      "diff --git a/c.txt b/c.txt\r\n--- a/c.txt\r\n+++ b/c.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n";
    const idx = new PatchIndex(p);
    expect(idx.has("new üname.txt")).toBe(true);
    expect(idx.parsed("new üname.txt")?.status).toBe("renamed");
    expect(idx.has("c.txt")).toBe(true);
    expect(idx.parsed("c.txt")?.additions).toBe(1);
  });
});
