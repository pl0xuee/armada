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

describe("match system", () => {
  it("is a valid choice that is not a theme of its own", async () => {
    const { SYSTEM_THEME, SYSTEM_DARK, SYSTEM_LIGHT, resolveTheme } = await import("./themes");
    expect(isThemeId(SYSTEM_THEME)).toBe(true);
    expect(THEME_IDS).not.toContain(SYSTEM_THEME);
    expect(resolveTheme("system", false)).toBe(SYSTEM_DARK);
    expect(resolveTheme("system", true)).toBe(SYSTEM_LIGHT);
    expect(THEMES.find((t) => t.id === SYSTEM_DARK)?.light).toBe(false);
    expect(THEMES.find((t) => t.id === SYSTEM_LIGHT)?.light).toBe(true);
  });

  it("leaves a fixed theme alone and falls back to the default for unknown values", async () => {
    const { resolveTheme } = await import("./themes");
    expect(resolveTheme("paper", false)).toBe("paper");
    expect(resolveTheme("midnight", true)).toBe("midnight");
    expect(resolveTheme("neon", true)).toBe("gunmetal");
    expect(resolveTheme(undefined, true)).toBe("gunmetal");
  });
});
