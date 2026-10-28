import { describe, expect, it } from "vitest";
import { streamDebounceMs } from "./useHighlight";

describe("streamDebounceMs", () => {
  it("backs off as the block grows", () => {
    expect(streamDebounceMs(10)).toBe(250);
    expect(streamDebounceMs(300)).toBe(250);
    expect(streamDebounceMs(301)).toBe(1000);
    expect(streamDebounceMs(4000)).toBe(1000);
  });
});
