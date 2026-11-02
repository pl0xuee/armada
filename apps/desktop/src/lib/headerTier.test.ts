import { describe, expect, it } from "vitest";
import { headerTier } from "./layout";

describe("headerTier", () => {
  it("folds secondary actions away before the title is squeezed to a few letters", () => {
    expect(headerTier(665, false)).toBe("compact"); // a 720px window (200% zoom) with the rail beside it
    expect(headerTier(799, false)).toBe("compact");
    expect(headerTier(800, false)).toBe("icons");
    expect(headerTier(999, false)).toBe("icons");
    expect(headerTier(1000, false)).toBe("full");
  });

  it("is full before the width is measured, and compact for a tile", () => {
    expect(headerTier(0, false)).toBe("full");
    expect(headerTier(1400, true)).toBe("compact");
  });
});
