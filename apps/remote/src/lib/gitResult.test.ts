import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { baseSyncLine, changeSummaryLine, commitResult, conflictPrompt, isConflict, isSecretsRefusal, isWarning, needsResultSheet, pushCommand, shipResult } from "./gitResult";

describe("commitResult", () => {
  it("reads the summary with skipped and left-over files", () => {
    const r = commitResult({
      result: { hash: "abc1234", files: ["a.ts"], leftUncommitted: 5, skipped: ["vendor/kit"], message: "Committed 1 file (abc1234); 5 other changed files were left uncommitted" },
    });
    expect(r).toEqual({
      kind: "committed",
      message: "Committed 1 file (abc1234); 5 other changed files were left uncommitted",
      files: ["a.ts"],
      skipped: ["vendor/kit"],
      leftUncommitted: 5,
    });
    expect(needsResultSheet(r)).toBe(true);
    expect(isWarning(r)).toBe(true);
  });
  it("keeps a clean commit to a toast", () => {
    const r = commitResult({ result: { hash: "abc", files: [], leftUncommitted: 0, skipped: [], message: "Committed 2 files (abc)" } });
    expect(needsResultSheet(r)).toBe(false);
    expect(isWarning(r)).toBe(false);
  });
  it("copes with a bare string, a missing message and junk", () => {
    expect(commitResult({ result: "legacy" })).toMatchObject({ message: "legacy" });
    expect(commitResult({ result: { hash: "abc" } })).toMatchObject({ message: "Committed abc" });
    expect(commitResult(undefined)).toMatchObject({ message: "Committed", skipped: [], leftUncommitted: 0 });
    expect(commitResult({ result: { skipped: ["a", 3, ""], leftUncommitted: -2 } })).toMatchObject({ skipped: ["a"], leftUncommitted: 0 });
  });
});

describe("shipResult", () => {
  it("is merged when there is no error, with the base branch status", () => {
    const r = shipResult({
      committed: "abc",
      merged: "Merged x into main: 2 files changed",
      error: null,
      baseStatus: { branch: "main", upstream: "origin/main", ahead: 2, behind: 0 },
    });
    expect(r).toEqual({
      kind: "merged",
      committed: "abc",
      summary: "Merged x into main: 2 files changed",
      baseStatus: { branch: "main", upstream: "origin/main", ahead: 2, behind: 0 },
    });
    expect(needsResultSheet(r)).toBe(true);
    expect(isWarning(r)).toBe(false);
  });
  it("tells a conflict from another merge failure", () => {
    expect(shipResult({ committed: "abc", error: "Committed abc on x, but the merge failed: CONFLICT in a.ts" })).toMatchObject({ kind: "conflict", committed: "abc" });
    expect(shipResult({ committed: null, error: "Committed abc on x, but the merge failed: base is checked out dirty" })).toMatchObject({ kind: "not_merged" });
    expect(isWarning(shipResult({ error: "boom" }))).toBe(true);
  });
  it("drops a malformed baseStatus", () => {
    expect(shipResult({ merged: "ok", baseStatus: { upstream: "origin/main" } })).toMatchObject({ kind: "merged", baseStatus: null });
  });
});

describe("desktop wording", () => {
  it("builds the conflict prompt", () => {
    expect(conflictPrompt({ branch: "armada/x", baseBranch: "main" }, "conflicts in a.ts")).toBe(
      "Merging armada/x into main failed:\n\nconflicts in a.ts\n\nPlease merge main into your branch, resolve the conflicts, make sure everything still builds and tests pass, and commit the result.",
    );
    expect(conflictPrompt({ branch: null, baseBranch: null }, "e")).toContain("Merging your branch into the base branch failed");
  });
  it("describes the base branch", () => {
    expect(baseSyncLine({ branch: "main", upstream: null, ahead: 0, behind: 0 })).toBe("Merged into main locally · main has no upstream on GitHub");
    expect(baseSyncLine({ branch: "main", upstream: "origin/main", ahead: 1, behind: 2 })).toBe(
      "Merged into main locally · 1 commit not on origin/main yet (origin/main also has 2 new commits)",
    );
    expect(baseSyncLine({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0 })).toBe("Merged into main · origin/main is up to date");
    expect(pushCommand({ branch: "main", upstream: "origin/main", ahead: 1, behind: 0 })).toBe("git push");
    expect(pushCommand({ branch: "dev", upstream: null, ahead: 0, behind: 0 })).toBe("git push -u origin dev");
  });
  it("suggests a rebase first when the upstream has new commits", () => {
    expect(pushCommand({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1 })).toBe("git pull --rebase && git push");
    expect(pushCommand({ branch: "dev", upstream: null, ahead: 1, behind: 3 })).toBe("git push -u origin dev");
  });
  it("detects conflicts", () => {
    expect(isConflict("Merge Conflict in x")).toBe(true);
    expect(isConflict("dirty tree")).toBe(false);
  });
});

describe("isSecretsRefusal", () => {
  const msg = "These files look like secrets: .env, a.key. Leave them out of the commit, or confirm to include them.";
  it("recognises the server's 422 about secret-looking files", () => {
    expect(isSecretsRefusal(new ApiError(422, msg))).toBe(true);
  });
  it("is not any other failure", () => {
    expect(isSecretsRefusal(new ApiError(422, "Nothing to commit"))).toBe(false);
    expect(isSecretsRefusal(new ApiError(400, msg))).toBe(false);
    expect(isSecretsRefusal(new ApiError(0, null))).toBe(false);
    expect(isSecretsRefusal(new Error(msg))).toBe(false);
  });
});

describe("changeSummaryLine", () => {
  it("counts files and lines", () => {
    expect(changeSummaryLine(3, 12, 4)).toBe("3 files · +12 −4");
    expect(changeSummaryLine(1, 0, 2)).toBe("1 file · +0 −2");
  });
});
