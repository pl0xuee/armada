import { describe, expect, it } from "vitest";
import { USER_FOLD_LINES, userMessageFolds, userMessageLines } from "./collapse";

describe("a long message you wrote", () => {
  it("counts wrapped lines, not only newlines", () => {
    expect(userMessageLines("short")).toBe(1);
    expect(userMessageLines("a\n\nb")).toBe(3);
    expect(userMessageLines("x".repeat(400))).toBe(5);
  });

  it("stays whole when it is a few lines", () => {
    expect(userMessageFolds("Fix the retry bug.\nAdd a test.")).toBe(false);
    expect(userMessageFolds("line\n".repeat(USER_FOLD_LINES))).toBe(false);
  });

  it("folds a pasted log or one long unbroken line", () => {
    expect(userMessageFolds("log line\n".repeat(400))).toBe(true);
    expect(userMessageFolds("A".repeat(5000))).toBe(true);
  });
});
