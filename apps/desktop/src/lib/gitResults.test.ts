import { describe, expect, it } from "vitest";
import { isConflict, prResult, shipOutcome } from "./gitResults";

describe("prResult", () => {
  it("passes a plain URL through", () => {
    expect(prResult("https://github.com/a/b/pull/1")).toEqual({ url: "https://github.com/a/b/pull/1", existed: false });
  });
  it("takes the last token when a PR already exists", () => {
    expect(prResult("A pull request already exists: https://github.com/a/b/pull/7")).toEqual({
      url: "https://github.com/a/b/pull/7",
      existed: true,
    });
  });
});

describe("shipOutcome", () => {
  it("is shipped without an error", () => {
    expect(shipOutcome({ committed: "abc", merged: "def", error: null })).toEqual({
      kind: "shipped",
      committed: "abc",
      merged: "def",
    });
  });
  it("is committed-not-merged with an error, flagging conflicts", () => {
    const o = shipOutcome({
      committed: "abc",
      merged: null,
      error: "Committed abc on x, but the merge failed: CONFLICT (content)",
    });
    expect(o.kind).toBe("committed_not_merged");
    expect(o.kind === "committed_not_merged" && o.conflict).toBe(true);
  });
  it("detects conflicts case-insensitively", () => {
    expect(isConflict("merge Conflict in a.ts")).toBe(true);
    expect(isConflict("not a fast-forward")).toBe(false);
  });
});
