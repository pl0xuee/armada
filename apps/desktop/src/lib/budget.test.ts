import { describe, expect, it } from "vitest";
import { budgetFill, budgetLevel, budgetPercent, capText, parseCap } from "./budget";

describe("budgetLevel", () => {
  it("warns at 80% and hits at 100%", () => {
    expect(budgetLevel(7.99, 10)).toBe("under");
    expect(budgetLevel(8, 10)).toBe("warn");
    expect(budgetLevel(9.99, 10)).toBe("warn");
    expect(budgetLevel(10, 10)).toBe("hit");
    expect(budgetLevel(99, 10)).toBe("hit");
  });
  it("is off without a usable cap", () => {
    expect(budgetLevel(1000, null)).toBe("under");
    expect(budgetLevel(1000, undefined)).toBe("under");
    expect(budgetLevel(1000, 0)).toBe("under");
    expect(budgetLevel(1000, Number.NaN)).toBe("under");
  });
});

describe("budgetPercent / budgetFill", () => {
  it("rounds and does not clamp the percent", () => {
    expect(budgetPercent(2.5, 10)).toBe(25);
    expect(budgetPercent(13, 10)).toBe(130);
    expect(budgetPercent(5, null)).toBeNull();
    expect(budgetPercent(-1, 10)).toBe(0);
  });
  it("clamps the fill", () => {
    expect(budgetFill(13, 10)).toBe(100);
    expect(budgetFill(5, 10)).toBe(50);
    expect(budgetFill(5, null)).toBe(0);
  });
});

describe("parseCap", () => {
  it("treats empty as no cap", () => {
    expect(parseCap("")).toEqual({ value: null });
    expect(parseCap("   ")).toEqual({ value: null });
  });
  it("accepts amounts, with a leading $ or thousands commas", () => {
    expect(parseCap("25")).toEqual({ value: 25 });
    expect(parseCap("$12.50")).toEqual({ value: 12.5 });
    expect(parseCap("1,200")).toEqual({ value: 1200 });
    expect(parseCap(".5")).toEqual({ value: 0.5 });
    expect(parseCap("3.456")).toEqual({ value: 3.46 });
  });
  it("rejects zero, negatives and junk", () => {
    expect(parseCap("0").error).toBeTruthy();
    expect(parseCap("-5").error).toBeTruthy();
    expect(parseCap("abc").error).toBeTruthy();
    expect(parseCap("1e3").error).toBeTruthy();
    expect(parseCap("99999999").error).toBeTruthy();
  });
});

describe("capText", () => {
  it("shows empty for no cap", () => {
    expect(capText(null)).toBe("");
    expect(capText(12.5)).toBe("12.5");
  });
});
