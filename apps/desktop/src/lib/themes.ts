import type { Settings } from "@/lib/types";

export type ThemeId = Settings["theme"];

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

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
}

export function isLightTheme(id: string | undefined): boolean {
  return THEMES.some((t) => t.id === id && t.light);
}
