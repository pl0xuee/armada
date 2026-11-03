import { describe, expect, it } from "vitest";
import { headerFold } from "./headerFold";

describe("headerFold", () => {
  it("shows everything before the width is measured", () => {
    expect(headerFold(0)).toEqual({ noBudget: false, tight: false });
  });

  it("drops the budget chip below 600px and folds the buttons into ⋯ below 520px", () => {
    expect(headerFold(640)).toEqual({ noBudget: false, tight: false });
    expect(headerFold(599)).toEqual({ noBudget: true, tight: false });
    expect(headerFold(520)).toEqual({ noBudget: true, tight: false });
    expect(headerFold(519)).toEqual({ noBudget: true, tight: true });
    // A tile in a 2-up grid at 1440px is about 400px wide.
    expect(headerFold(395)).toEqual({ noBudget: true, tight: true });
  });
});
