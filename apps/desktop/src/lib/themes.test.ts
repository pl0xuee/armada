import { describe, expect, it } from "vitest";
import { isLightTheme, isThemeId, THEMES, THEME_IDS } from "./themes";

describe("themes", () => {
  it("has a unique id and a name for every theme", () => {
    expect(new Set(THEME_IDS).size).toBe(THEMES.length);
    for (const t of THEMES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("lists dark themes before light ones, so the picker reads dark then light", () => {
    const firstLight = THEMES.findIndex((t) => t.light);
    expect(THEMES.slice(firstLight).every((t) => t.light)).toBe(true);
  });

  it("knows which ids are themes and which are light", () => {
    expect(isThemeId("paper")).toBe(true);
    expect(isThemeId("neon")).toBe(false);
    expect(isThemeId(3)).toBe(false);
    expect(isLightTheme("lilac")).toBe(true);
    expect(isLightTheme("midnight")).toBe(false);
    expect(isLightTheme(undefined)).toBe(false);
  });
});
