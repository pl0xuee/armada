import { describe, expect, it } from "vitest";
import { HL_SLICE_LINES, sliceLines, streamDebounceMs } from "./useHighlight";

describe("streamDebounceMs", () => {
  it("backs off as the block grows", () => {
    expect(streamDebounceMs(10)).toBe(250);
    expect(streamDebounceMs(300)).toBe(250);
    expect(streamDebounceMs(301)).toBe(1000);
    expect(streamDebounceMs(4000)).toBe(1000);
  });
});

describe("sliceLines", () => {
  it("splits long hunks into bounded slices, keeping every line in order", () => {
    const lines = Array.from({ length: HL_SLICE_LINES * 2 + 5 }, (_, i) => i);
    const out = sliceLines(lines);
    expect(out.map((s) => s.length)).toEqual([HL_SLICE_LINES, HL_SLICE_LINES, 5]);
    expect(out.flat()).toEqual(lines);
  });
  it("returns one empty slice for an empty hunk", () => {
    expect(sliceLines([])).toEqual([[]]);
  });
});
