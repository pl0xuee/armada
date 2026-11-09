import type { Settings } from "@/lib/types";

/** What Settings.theme can hold: a theme, or "system" to follow the OS light/dark setting. */
export type ThemeChoice = Settings["theme"];
/** A theme that has its own set of variables in styles/globals.css. */
export type ThemeId = Exclude<ThemeChoice, "system">;

export const SYSTEM_THEME = "system" as const;
/** The themes "Match system" switches between. */
export const SYSTEM_DARK: ThemeId = "gunmetal";
export const SYSTEM_LIGHT: ThemeId = "titanium";

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  description: string;
  light: boolean;
}

/** Every theme, dark ones first. Each one is a set of variables in styles/globals.css. */
export const THEMES: ThemeInfo[] = [
  { id: "gunmetal", name: "Gunmetal", description: "Cool steel. The default.", light: false },
  { id: "carbon", name: "Carbon", description: "Neutral, deepest blacks", light: false },
  { id: "midnight", name: "Midnight", description: "Deep navy, soft blue", light: false },
  { id: "forest", name: "Forest", description: "Deep green, easy on the eyes", light: false },
  { id: "dusk", name: "Dusk", description: "Warm purple twilight", light: false },
  { id: "ember", name: "Ember", description: "Warm charcoal, orange glow", light: false },
  { id: "titanium", name: "Titanium", description: "Light, brushed metal", light: true },
  { id: "paper", name: "Paper", description: "Light, warm and easy to read", light: true },
  { id: "lilac", name: "Lilac", description: "Light with a soft purple tint", light: true },
];

export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id);

export function isThemeId(v: unknown): v is ThemeChoice {
  return v === SYSTEM_THEME || (typeof v === "string" && (THEME_IDS as readonly string[]).includes(v));
}

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** True when the OS is set to a light appearance (false when it can't be told). */
export function systemPrefersLight(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.(LIGHT_QUERY).matches;
  } catch {
    return false;
  }
}

/** The theme to draw: "Match system" becomes the dark or light theme the OS asks for. */
export function resolveTheme(id: string | undefined, prefersLight: boolean = systemPrefersLight()): ThemeId {
  if (id === SYSTEM_THEME) return prefersLight ? SYSTEM_LIGHT : SYSTEM_DARK;
  return isThemeId(id) ? (id as ThemeId) : "gunmetal";
}

/** Where the chosen theme is remembered so index.html can paint it before settings load (keep in step with its inline script). */
export const THEME_CACHE_KEY = "kvistcode.theme";

/** Remember the theme choice ("system" included) for the next launch's first paint. */
export function cacheThemeChoice(choice: string | undefined): void {
  if (!isThemeId(choice)) return;
  try {
    localStorage.setItem(THEME_CACHE_KEY, choice);
  } catch {
    // Storage can be unavailable; the next launch just paints the default first.
  }
}

export function isLightTheme(id: string | undefined): boolean {
  if (id === SYSTEM_THEME) return systemPrefersLight();
  return THEMES.some((t) => t.id === id && t.light);
}
