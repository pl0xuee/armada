import { describe, expect, it } from "vitest";
import { cUnquote, diffFromTexts, parseFileDiff, parseGitHeader, parseUnified } from "./diff";

describe("cUnquote", () => {
  it("returns unquoted input unchanged", () => {
    expect(cUnquote("a/plain.txt")).toBe("a/plain.txt");
  });
  it("decodes escaped quotes, backslashes and tabs", () => {
    expect(cUnquote('"a/we\\"ird\\\\name\\tx"')).toBe('a/we"ird\\name\tx');
  });
  it("decodes octal escapes as UTF-8 bytes", () => {
    expect(cUnquote('"a/caf\\303\\251.txt"')).toBe("a/café.txt");
    expect(cUnquote('"\\346\\227\\245\\346\\234\\254.md"')).toBe("日本.md");
  });
});

describe("parseGitHeader", () => {
  it("parses symmetric unquoted paths, even with ' b/' inside", () => {
    expect(parseGitHeader("diff --git a/src/a b/c.ts b/src/a b/c.ts")).toEqual({
      oldPath: "src/a b/c.ts",
      newPath: "src/a b/c.ts",
    });
  });
  it("parses quoted paths on both sides", () => {
    expect(parseGitHeader('diff --git "a/we\\"ird" "b/we\\"ird"')).toEqual({ oldPath: 'we"ird', newPath: 'we"ird' });
  });
  it("parses a rename without quoting", () => {
    expect(parseGitHeader("diff --git a/old.ts b/new.ts")).toEqual({ oldPath: "old.ts", newPath: "new.ts" });
  });
});

const MULTI = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import x from "x";
-const a = 1;
+const a = 2;
+const b = 3;
 export { a };
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

describe("parseUnified", () => {
  it("parses multiple files with statuses and counts", () => {
    const files = parseUnified(MULTI);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["src/app.ts", "modified", 2, 1],
      ["new.txt", "added", 2, 0],
      ["gone.txt", "deleted", 0, 1],
    ]);
  });

  it("numbers lines and ignores '\\ No newline'", () => {
    const [, added] = parseUnified(MULTI);
    expect(added.hunks[0].lines).toEqual([
      { type: "add", text: "hello", oldNo: null, newNo: 1 },
      { type: "add", text: "world", oldNo: null, newNo: 2 },
    ]);
    const [app] = parseUnified(MULTI);
    expect(app.hunks[0].lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
    ]);
  });

  it("uses rename from/to for renamed files", () => {
    const patch = `diff --git a/dir b/old.ts b/dir b/new.ts
similarity index 90%
rename from dir b/old.ts
rename to dir b/new.ts
--- a/dir b/old.ts
+++ b/dir b/new.ts
@@ -1 +1 @@
-a
+b
`;
    const [f] = parseUnified(patch);
    expect(f.status).toBe("renamed");
    expect(f.path).toBe("dir b/new.ts");
    expect(f.oldPath).toBe("dir b/old.ts");
  });

  it("handles a pure rename with no hunks", () => {
    const [f] = parseUnified("diff --git a/x.ts b/y.ts\nsimilarity index 100%\nrename from x.ts\nrename to y.ts\n");
    expect([f.path, f.oldPath, f.status, f.hunks.length]).toEqual(["y.ts", "x.ts", "renamed", 0]);
  });

  it("decodes C-quoted file names", () => {
    const patch = `diff --git "a/caf\\303\\251 \\"menu\\".txt" "b/caf\\303\\251 \\"menu\\".txt"
--- "a/caf\\303\\251 \\"menu\\".txt"
+++ "b/caf\\303\\251 \\"menu\\".txt"
@@ -1 +1 @@
-old
+new
`;
    const [f] = parseUnified(patch);
    expect(f.path).toBe('café "menu".txt');
    expect(f.status).toBe("modified");
  });

  it("does not treat a deleted '-- ' line as a file header inside a hunk", () => {
    const patch = `--- a/notes.md
+++ b/notes.md
@@ -1,2 +1,2 @@
--- heading
+++ heading
 tail
`;
    const files = parseUnified(patch);
    expect(files).toHaveLength(1);
    expect(files[0].hunks[0].lines.map((l) => [l.type, l.text])).toEqual([
      ["del", "-- heading"],
      ["add", "++ heading"],
      ["context", "tail"],
    ]);
  });

  it("attributes header-less hunks to the fallback path", () => {
    const [f] = parseUnified("@@ -3,2 +3,2 @@\n x\n-y\n+z\n", "src/b.ts");
    expect(f.path).toBe("src/b.ts");
    expect([f.additions, f.deletions]).toEqual([1, 1]);
    expect(f.hunks[0].lines[0]).toEqual({ type: "context", text: "x", oldNo: 3, newNo: 3 });
  });

  it("starts a new hunk on @@ even when the previous hunk's counts were wrong", () => {
    const [f] = parseUnified("@@ -1,9 +1,9 @@\n a\n-b\n+c\n@@ -20,1 +20,1 @@\n-d\n+e\n", "f.ts");
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[1].lines[0]).toEqual({ type: "del", text: "d", oldNo: 20, newNo: null });
  });

  it("flags binary files", () => {
    const [f] = parseUnified("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n");
    expect(f.binary).toBe(true);
  });
});

describe("diffFromTexts / parseFileDiff", () => {
  it("builds a diff from old/new text", () => {
    const f = diffFromTexts("a.txt", "one\ntwo\n", "one\nthree\n");
    expect([f.additions, f.deletions, f.status]).toEqual([1, 1, "modified"]);
  });
  it("marks new files as added", () => {
    expect(diffFromTexts("n.txt", null, "x\n").status).toBe("added");
  });
  it("prefers the contract path for header-less unified diffs", () => {
    const [f] = parseFileDiff({ path: "src/z.ts", oldText: null, newText: null, unified: "@@ -1 +1 @@\n-a\n+b\n" });
    expect(f.path).toBe("src/z.ts");
  });
});
