import { describe, expect, it } from "vitest";
import { baseSyncLine, isConflict, mergeToast, prResult, pushCommand, shipOutcome } from "./gitResults";

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
    expect(shipOutcome({ committed: "abc", merged: "def", error: null, baseStatus: null })).toEqual({
      kind: "shipped",
      committed: "abc",
      merged: "def",
      baseStatus: null,
    });
  });
  it("is committed-not-merged with an error, flagging conflicts", () => {
    const o = shipOutcome({
      committed: "abc",
      merged: null,
      error: "Committed abc on x, but the merge failed: CONFLICT (content)",
      baseStatus: null,
    });
    expect(o.kind).toBe("committed_not_merged");
    expect(o.kind === "committed_not_merged" && o.conflict).toBe(true);
  });
  it("detects conflicts case-insensitively", () => {
    expect(isConflict("merge Conflict in a.ts")).toBe(true);
    expect(isConflict("not a fast-forward")).toBe(false);
  });
});

describe("base branch sync wording", () => {
  const st = { branch: "master", upstream: "origin/master", ahead: 2, behind: 0 };
  it("says the merge is local and counts unpushed commits", () => {
    expect(baseSyncLine(st)).toBe("Merged into master locally · 2 commits not on origin/master yet");
    expect(baseSyncLine({ ...st, ahead: 1 })).toContain("1 commit not on");
  });
  it("mentions upstream commits we lack", () => {
    expect(baseSyncLine({ ...st, behind: 3 })).toContain("also has 3 new commits");
  });
  it("handles a missing upstream and an up-to-date base", () => {
    expect(baseSyncLine({ ...st, upstream: null })).toBe(
      "Merged into master locally · master has no upstream on GitHub",
    );
    expect(baseSyncLine({ ...st, ahead: 0 })).toBe("Merged into master · origin/master is up to date");
  });
  it("suggests the right terminal command", () => {
    expect(pushCommand(st)).toBe("git push");
    expect(pushCommand({ ...st, upstream: null })).toBe("git push -u origin master");
  });
  it("toast says local", () => {
    expect(mergeToast("agent-x", "master", st)).toBe(
      "agent-x is merged into master locally (not pushed to origin/master).",
    );
    expect(mergeToast("agent-x", "master", null)).toContain("local only");
  });
});
