import type { SettingsSection } from "@/store/ui";

/**
 * Settings has nine pages. The older section ids (what the voice assistant, the command
 * palette, deep links and other screens still pass to `openSettings`) stay valid: each one
 * maps to the page that now holds it, and to a heading on that page to scroll to.
 */
export const PAGE_OF: Record<SettingsSection, SettingsSection> = {
  appearance: "appearance",
  behavior: "appearance",
  notifications: "notifications",
  sounds: "notifications",
  budgets: "budgets",
  projects: "projects",
  templates: "projects",
  toolkit: "toolkit",
  providers: "providers",
  tools: "providers",
  agents: "providers",
  voice: "voice",
  assistant: "voice",
  remote: "remote",
  about: "about",
};

/** Ids that land partway down a merged page. The page marks that spot with `data-settings-anchor`. */
export const ANCHOR_OF: Partial<Record<SettingsSection, string>> = {
  behavior: "behavior",
  sounds: "sounds",
  templates: "templates",
  tools: "tools",
  agents: "agents",
  assistant: "assistant",
};

/** Plain words people (and the voice assistant) may use instead of an id. */
const WORDS: Record<string, SettingsSection> = {
  general: "appearance",
  theme: "appearance",
  alerts: "notifications",
  sound: "sounds",
  "save-tokens": "behavior",
  tokens: "behavior",
  mcp: "toolkit",
  skills: "toolkit",
  instructions: "toolkit",
  "voice-assistant": "assistant",
  "custom-agents": "agents",
  "agent-tools": "tools",
  mobile: "remote",
  phone: "remote",
  usage: "budgets",
};

/** The id for something typed in a link or said aloud, or null when it isn't a settings section. */
export function parseSection(raw: string | null | undefined): SettingsSection | null {
  const key = (raw ?? "").trim().toLowerCase();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(PAGE_OF, key)) return key as SettingsSection;
  return Object.prototype.hasOwnProperty.call(WORDS, key) ? WORDS[key] : null;
}
