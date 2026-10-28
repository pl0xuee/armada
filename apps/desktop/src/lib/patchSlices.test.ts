import { describe, expect, it } from "vitest";
import { cUnquote, findFileSlice, hunkPatch, slicePatch } from "./patchSlices";

const TWO_FILES = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,2 +10,3 @@ export function f() {
 ten
+ten and a half
 eleven
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+export const b = 1;
+export const c = 2;
`;

describe("slicePatch", () => {
  it("cuts exact file sections and hunks", () => {
    const files = slicePatch(TWO_FILES);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    const [a, b] = files;
    expect(a.hunks).toHaveLength(2);
    expect(a.header).toBe(
      "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n",
    );
    expect(a.hunks[1].text).toBe("@@ -10,2 +10,3 @@ export function f() {\n ten\n+ten and a half\n eleven\n");
    // Sections concatenate back to the original patch byte-for-byte.
    expect(files.map((f) => f.text).join("")).toBe(TWO_FILES);
    expect(b.hunks).toHaveLength(1);
    expect(b.header).toContain("new file mode 100644");
  });

  it("builds a hunk patch from the header plus exactly one hunk", () => {
    const [a] = slicePatch(TWO_FILES);
    const p = hunkPatch(a, 0)!;
    expect(p.startsWith("diff --git a/src/a.ts b/src/a.ts\n")).toBe(true);
    expect(p).toContain("@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n");
    expect(p).not.toContain("@@ -10,2");
    expect(hunkPatch(a, 5)).toBeNull();
  });

  it("does not split on ---/+++ content lines inside a git hunk", () => {
    const patch = `diff --git a/x.md b/x.md
--- a/x.md
+++ b/x.md
@@ -1,2 +1,2 @@
--- old rule
+++ new rule
 keep
`;
    const files = slicePatch(patch);
    expect(files).toHaveLength(1);
    expect(files[0].hunks[0].text).toContain("--- old rule\n+++ new rule\n");
  });

  it("handles C-quoted paths and renames", () => {
    const patch = `diff --git "a/we\\"ird name.txt" "b/we\\"ird name.txt"
--- "a/we\\"ird name.txt"
+++ "b/we\\"ird name.txt"
@@ -1 +1 @@
-a
+b
diff --git a/old/p.ts b/new/p.ts
similarity index 90%
rename from old/p.ts
rename to new/p.ts
--- a/old/p.ts
+++ b/new/p.ts
@@ -1 +1 @@
-x
+y
`;
    const [q, r] = slicePatch(patch);
    expect(q.path).toBe('we"ird name.txt');
    expect(r.path).toBe("new/p.ts");
    expect(r.oldPath).toBe("old/p.ts");
  });

  it("splits plain unified diffs (no git headers) using hunk line counts", () => {
    const patch = `--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
--- not a header
+++ also not a header
--- a/two.txt
+++ b/two.txt
@@ -1 +1 @@
-p
+q
`;
    const files = slicePatch(patch);
    expect(files.map((f) => f.path)).toEqual(["one.txt", "two.txt"]);
    expect(files[0].hunks[0].text).toBe("@@ -1 +1 @@\n--- not a header\n+++ also not a header\n");
  });

  it("keeps binary and mode-only sections without hunks", () => {
    const patch = `diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
`;
    const [f] = slicePatch(patch);
    expect(f.path).toBe("img.png");
    expect(f.hunks).toHaveLength(0);
    expect(f.text).toBe(patch);
  });

  it("normalises CRLF and adds a final newline", () => {
    const [f] = slicePatch("--- a/a\r\n+++ b/a\r\n@@ -1 +1 @@\r\n-a\r\n+b");
    expect(f.hunks[0].text).toBe("@@ -1 +1 @@\n-a\n+b\n");
  });
});

describe("cUnquote", () => {
  it("decodes escapes and octal UTF-8 bytes", () => {
    expect(cUnquote('"a\\tb\\\\c\\"d"')).toBe('a\tb\\c"d');
    expect(cUnquote('"caf\\303\\251"')).toBe("café");
    expect(cUnquote("plain")).toBe("plain");
  });
});

describe("findFileSlice", () => {
  it("matches exact paths, then suffixes", () => {
    const files = slicePatch(TWO_FILES);
    expect(findFileSlice(files, "src/b.ts")?.path).toBe("src/b.ts");
    expect(findFileSlice(files, "b.ts")?.path).toBe("src/b.ts");
    expect(findFileSlice(files, "/home/me/repo/src/a.ts")?.path).toBe("src/a.ts");
    expect(findFileSlice(files, "nope.ts")).toBeUndefined();
  });
});
