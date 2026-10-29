import { describe, expect, it } from "vitest";
import { PatchIndex } from "./patchIndex";
import { BIG_FILE_LINES, compactLabel, createLatest, isBigFile, isCompactFile, orderReviewFiles } from "./reviewFiles";
import type { ChangedFile } from "./types";

const f = (path: string, o: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
  lfs: false,
  ...o,
});
const patch =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n" +
  "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n" +
  "diff --git a/z.ts b/z.ts\n--- a/z.ts\n+++ b/z.ts\n@@ -1 +1 @@\n-a\n+b\n";
const idx = new PatchIndex(patch);

describe("orderReviewFiles", () => {
  const files = [
    f("img.png", { additions: 0, deletions: 0 }),
    f("a.ts"),
    f("tex.psd", { lfs: true }),
    f("z.ts"),
    f("gone.bin"),
  ];

  it("puts text first and binary/LFS/diff-less after, keeping order inside each group", () => {
    const o = orderReviewFiles(files, idx, false);
    expect(o.list.map((x) => x.path)).toEqual(["a.ts", "z.ts", "img.png", "tex.psd", "gone.bin"]);
    expect(o.textCount).toBe(2);
    expect(o.compactCount).toBe(3);
  });

  it("can hide the compact group", () => {
    const o = orderReviewFiles(files, idx, true);
    expect(o.list.map((x) => x.path)).toEqual(["a.ts", "z.ts"]);
    expect(o.compactCount).toBe(3);
  });

  it("classifies and labels", () => {
    expect(isCompactFile(f("tex.psd", { lfs: true }), idx)).toBe(true);
    expect(isCompactFile(f("a.ts"), idx)).toBe(false);
    expect(compactLabel(f("tex.psd", { lfs: true }), idx)).toBe("LFS object · size changed");
    expect(compactLabel(f("img.png"), idx)).toBe("Binary file");
    expect(compactLabel(f("cut.ts"), idx)).toBe("No textual diff");
    expect(compactLabel(f("cut.ts"), idx, true)).toBe("Diff not loaded (over 8 MB)");
    expect(compactLabel(f("img.png"), idx, true)).toBe("Binary file");
    expect(compactLabel(f("gone.bin"), idx)).toBe("No textual diff");
  });
});

describe("isBigFile", () => {
  it("collapses past the line threshold", () => {
    expect(isBigFile({ additions: BIG_FILE_LINES, deletions: 0 })).toBe(false);
    expect(isBigFile({ additions: BIG_FILE_LINES, deletions: 1 })).toBe(true);
  });
});

describe("createLatest (out-of-order response guard)", () => {
  it("only the newest request is current", () => {
    const l = createLatest();
    const a = l.begin();
    const b = l.begin();
    expect(l.isCurrent(a)).toBe(false);
    expect(l.isCurrent(b)).toBe(true);
  });

  it("a slow older response cannot overwrite a newer one", async () => {
    const l = createLatest();
    let shown = "";
    const load = async (label: string, ms: number) => {
      const t = l.begin();
      await new Promise((r) => setTimeout(r, ms));
      if (l.isCurrent(t)) shown = label;
    };
    await Promise.all([load("old", 30), load("new", 5)]);
    expect(shown).toBe("new");
  });

  it("cancel drops everything in flight", async () => {
    const l = createLatest();
    const t = l.begin();
    l.cancel();
    expect(l.isCurrent(t)).toBe(false);
  });
});
