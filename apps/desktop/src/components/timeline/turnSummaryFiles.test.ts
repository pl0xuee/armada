import { describe, expect, it } from "vitest";
import { FILES_SHOWN, visibleFiles } from "./TurnSummaryCard";

const files = (n: number) => Array.from({ length: n }, (_, i) => `src/file${i}.ts`);

describe("turn summary file chips", () => {
  it("shows every file when they fit", () => {
    expect(visibleFiles(files(FILES_SHOWN), false)).toEqual({ shown: files(FILES_SHOWN), hidden: 0 });
  });

  it("folds a long list behind +N more", () => {
    const { shown, hidden } = visibleFiles(files(15), false);
    expect(shown).toHaveLength(FILES_SHOWN - 1);
    expect(hidden).toBe(15 - (FILES_SHOWN - 1));
  });

  it("never folds just one file", () => {
    expect(visibleFiles(files(FILES_SHOWN + 1), false).hidden).toBeGreaterThan(1);
  });

  it("shows them all once opened", () => {
    expect(visibleFiles(files(15), true)).toEqual({ shown: files(15), hidden: 0 });
  });
});
