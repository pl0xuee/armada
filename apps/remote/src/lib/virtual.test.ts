import { describe, expect, it } from "vitest";
import { firstIndexAfter, prefixSums, visibleRange } from "./virtual";

describe("virtual list math", () => {
  const offsets = prefixSums(5, (i) => [10, 20, 30, 40, 50][i]); // 0,10,30,60,100,150
  it("builds offsets", () => expect([...offsets]).toEqual([0, 10, 30, 60, 100, 150]));
  it("finds the first row starting after y", () => {
    expect(firstIndexAfter(offsets, -1)).toBe(0);
    expect(firstIndexAfter(offsets, 0)).toBe(1);
    expect(firstIndexAfter(offsets, 59)).toBe(3);
    expect(firstIndexAfter(offsets, 1000)).toBe(5);
  });
  it("selects rows in the viewport plus overscan", () => {
    expect(visibleRange(offsets, 35, 65, 0)).toEqual([2, 4]);
    expect(visibleRange(offsets, 35, 65, 20)).toEqual([1, 4]);
    expect(visibleRange(offsets, 0, 1000, 0)).toEqual([0, 5]);
    expect(visibleRange(prefixSums(0, () => 0), 0, 100, 10)).toEqual([0, 0]);
  });
  it("stays fast for 100k rows", () => {
    const big = prefixSums(100_000, (i) => 40 + (i % 7));
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) visibleRange(big, i * 37, i * 37 + 844, 600);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
