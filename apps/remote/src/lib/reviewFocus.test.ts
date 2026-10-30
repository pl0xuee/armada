import { describe, expect, it } from "vitest";
import { findFileIndex, setReviewFocus, takeReviewFocus } from "./reviewFocus";

describe("review focus hand-off", () => {
  it("is handed to the right agent exactly once", () => {
    setReviewFocus("a1", "src/x.ts");
    expect(takeReviewFocus("a2")).toBeNull();
    setReviewFocus("a1", "src/x.ts");
    expect(takeReviewFocus("a1")).toBe("src/x.ts");
    expect(takeReviewFocus("a1")).toBeNull();
  });
});

describe("findFileIndex", () => {
  const paths = ["src/a.ts", "src/deep/b.ts", "README.md"];
  it("matches exact and relative-vs-absolute paths", () => {
    expect(findFileIndex(paths, "src/deep/b.ts")).toBe(1);
    expect(findFileIndex(paths, "/home/u/proj/src/deep/b.ts")).toBe(1);
    expect(findFileIndex(paths, "./README.md")).toBe(2);
    expect(findFileIndex(["proj/src/a.ts"], "src/a.ts")).toBe(0);
  });
  it("doesn't match on a partial file name", () => {
    expect(findFileIndex(["src/a.ts"], "/p/src/aa.ts")).toBe(-1);
    expect(findFileIndex(["a.ts"], "/p/data.ts")).toBe(-1);
    expect(findFileIndex(paths, "missing.ts")).toBe(-1);
  });
});
