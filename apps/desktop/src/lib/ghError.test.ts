import { describe, expect, it } from "vitest";
import { BRANCH_CHANGED_MESSAGE, DETAILS_MARK, detailsText, isBranchChanged, splitDetails } from "./ghError";

describe("gh error text", () => {
  it("splits the sentence from gh's own words", () => {
    expect(splitDetails("Plain sentence.")).toEqual({ message: "Plain sentence.", details: null });
    expect(splitDetails(`Couldn't reach GitHub.${DETAILS_MARK}dial tcp: no such host\n`)).toEqual({
      message: "Couldn't reach GitHub.",
      details: "dial tcp: no such host",
    });
    expect(splitDetails(`Sentence.${DETAILS_MARK}`).details).toBeNull();
  });

  it("recognises the branch-changed answer, and only that", () => {
    // Same text the Rust side sends (gh_errors.rs BRANCH_CHANGED).
    expect(BRANCH_CHANGED_MESSAGE).toBe("The branch changed since you looked. Review the new commits.");
    expect(isBranchChanged(BRANCH_CHANGED_MESSAGE)).toBe(true);
    expect(isBranchChanged(`${BRANCH_CHANGED_MESSAGE}${DETAILS_MARK}raw`)).toBe(true);
    expect(isBranchChanged("The base branch changed while you were merging. Try again.")).toBe(false);
    expect(isBranchChanged("")).toBe(false);
  });

  it("builds the text 'Copy details' copies", () => {
    expect(detailsText(`Sentence.${DETAILS_MARK}raw words`, "Merging #7")).toBe("Merging #7\n\nSentence.\n\nraw words");
    expect(detailsText("Sentence.")).toBe("Sentence.");
  });
});
