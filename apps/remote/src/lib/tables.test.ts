import { describe, expect, it } from "vitest";
import { isNumericCell, numericColumns } from "./tables";

describe("isNumericCell", () => {
  it("accepts numbers with signs, units, currency and separators", () => {
    for (const c of ["12", "-3.5", "+4%", "$1,200", "38 ms", "1.2k", "3x", "~40", "**7**", "`9`"]) expect(isNumericCell(c)).toBe(true);
  });
  it("rejects words and mixed text", () => {
    for (const c of ["fast", "v2 beta", "12 apples", "n/a", ""]) expect(isNumericCell(c)).toBe(false);
  });
});

describe("numericColumns", () => {
  const head = ["Name", "p50", "p99", "Note"];
  const rows = [
    ["a", "12 ms", "40 ms", "fine"],
    ["b", "9 ms", "-", "slow"],
  ];
  it("right-aligns columns that only hold numbers (placeholders ignored)", () => {
    expect(numericColumns(head, rows, [null, null, null, null])).toEqual([false, true, true, false]);
  });
  it("leaves a column the writer aligned alone", () => {
    expect(numericColumns(head, rows, [null, "left", null, null])).toEqual([false, false, true, false]);
  });
  it("needs at least one number", () => {
    expect(numericColumns(["x"], [["-"], [""]], [null])).toEqual([false]);
  });
});
