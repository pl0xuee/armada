import { describe, expect, it } from "vitest";
import { restoreDraft } from "./draftRestore";

describe("restoreDraft", () => {
  it("restores the sent text into an empty draft", () => {
    expect(restoreDraft("", "hello")).toBe("hello");
    expect(restoreDraft("  \n", "hello")).toBe("hello");
  });
  it("keeps what was typed since, with the sent text in front", () => {
    expect(restoreDraft("next thing", "hello")).toBe("hello\n\nnext thing");
  });
  it("does not duplicate text that is already there", () => {
    expect(restoreDraft("hello", "hello")).toBe("hello");
  });
});
