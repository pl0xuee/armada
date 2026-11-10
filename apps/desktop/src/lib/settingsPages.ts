import type { ToolkitTab } from "@/lib/toolkit";
import type { SettingsSection } from "@/store/ui";

/** The pages in the Settings sidebar, in their groups. */
export type SettingsPage =
  | "appearance"
  | "keyboard"
  | "notifications"
  | "behavior"
  | "models"
  | "providers"
  | "projects"
  | "templates"
  | "remote"
  | "voice"
  | "about";

export const PAGE_LABEL: Record<SettingsPage, string> = {
  appearance: "General",
  keyboard: "Keyboard",
  notifications: "Alerts & sounds",
  behavior: "New agents",
  models: "Models & spending",
  providers: "Providers",
  projects: "Projects",
  templates: "Templates",
  remote: "Phone & remote",
  voice: "Voice",
  about: "About",
};

/** Sidebar groups. A group without a title sits apart at the bottom. */
export const NAV_GROUPS: { title: string | null; pages: SettingsPage[] }[] = [
  { title: "App", pages: ["appearance", "keyboard", "notifications"] },
  { title: "Agents", pages: ["behavior", "models", "providers"] },
  { title: "Workspace", pages: ["projects", "templates"] },
  { title: "Phone & voice", pages: ["remote", "voice"] },
  { title: null, pages: ["about"] },
];

/**
 * Every section id maps to the page that holds it. Older ids (what the voice assistant, the
 * command palette, deep links and other screens still pass to `openSettings`) stay valid.
 */
export const PAGE_OF: Record<SettingsSection, SettingsPage> = {
  appearance: "appearance",
  keyboard: "keyboard",
  notifications: "notifications",
  sounds: "notifications",
  behavior: "behavior",
  models: "models",
  budgets: "models",
  providers: "providers",
  tools: "providers",
  agents: "providers",
  projects: "projects",
  toolkit: "projects",
  templates: "templates",
  remote: "remote",
  voice: "voice",
  assistant: "voice",
  about: "about",
};

/** Ids that land partway down a page. The page marks that spot with `data-settings-anchor`. */
export const ANCHOR_OF: Partial<Record<SettingsSection, string>> = {
  sounds: "sounds",
  budgets: "budgets",
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
  shortcuts: "keyboard",
  hotkey: "keyboard",
  "new-agents": "behavior",
  "save-tokens": "models",
  tokens: "models",
  usage: "budgets",
  mcp: "toolkit",
  skills: "toolkit",
  instructions: "toolkit",
  "voice-assistant": "assistant",
  "custom-agents": "agents",
  "agent-tools": "tools",
  mobile: "remote",
  phone: "remote",
};

/** The id for something typed in a link or said aloud, or null when it isn't a settings section. */
export function parseSection(raw: string | null | undefined): SettingsSection | null {
  const key = (raw ?? "").trim().toLowerCase();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(PAGE_OF, key)) return key as SettingsSection;
  return Object.prototype.hasOwnProperty.call(WORDS, key) ? WORDS[key] : null;
}

// ---------------------------------------------------------------- search

/** One thing the Settings search can find, and where it lives. */
export interface SettingsEntry {
  label: string;
  page: SettingsPage;
  /** A `data-settings-anchor` on that page to scroll to. */
  anchor?: string;
  /** The Projects tab it is on. */
  tab?: ToolkitTab;
  keywords?: string[];
}

export const SETTINGS_INDEX: readonly SettingsEntry[] = [
  { label: "Theme", page: "appearance", keywords: ["appearance", "dark", "light", "colors", "match system"] },
  { label: "Interface scale", page: "appearance", keywords: ["zoom", "size", "bigger", "smaller", "text"] },
  { label: "Close to tray", page: "appearance", anchor: "window", keywords: ["window", "tray", "background"] },
  { label: "Launch at login", page: "appearance", anchor: "window", keywords: ["startup", "autostart", "boot"] },
  { label: "Updates", page: "appearance", anchor: "updates", keywords: ["version", "check for updates", "install"] },
  { label: "Global hotkey", page: "keyboard", keywords: ["shortcut", "bring forward", "show window"] },
  { label: "One-letter shortcuts", page: "keyboard", keywords: ["keys", "approve", "single key"] },
  { label: "Keyboard shortcuts", page: "keyboard", anchor: "shortcuts", keywords: ["keys", "list", "cheat sheet"] },
  { label: "Desktop notifications", page: "notifications", keywords: ["notify", "alerts", "popups"] },
  { label: "Smart mute", page: "notifications", keywords: ["mute", "watching", "chime"] },
  { label: "Re-ping pending approvals", page: "notifications", anchor: "reminders", keywords: ["remind", "escalate"] },
  {
    label: "Quiet hours",
    page: "notifications",
    anchor: "quiet-hours",
    keywords: ["do not disturb", "dnd", "night", "schedule"],
  },
  { label: "Slack, Discord and webhooks", page: "notifications", anchor: "webhooks", keywords: ["webhook", "alerts"] },
  { label: "Sounds", page: "notifications", anchor: "sounds", keywords: ["audio", "volume", "sound pack", "custom"] },
  { label: "Permission mode for new agents", page: "behavior", keywords: ["auto", "ask", "approvals"] },
  { label: "Remembered composer choices", page: "behavior", keywords: ["composer", "remember"] },
  { label: "Auto-resume interrupted agents", page: "behavior", keywords: ["crash", "reboot", "restart"] },
  { label: "Use a git worktree by default", page: "behavior", keywords: ["branch", "worktree", "folder"] },
  { label: "How agents reply", page: "behavior", anchor: "replies", keywords: ["report", "style", "language"] },
  { label: "Helper agents", page: "behavior", anchor: "helpers", keywords: ["busy", "queue", "side agent"] },
  {
    label: "Recommended models",
    page: "models",
    keywords: ["opus", "sonnet", "haiku", "fable", "model guide", "effort", "switch agents"],
  },
  {
    label: "Save tokens",
    page: "models",
    anchor: "save-tokens",
    keywords: ["compact", "summarize", "context", "output"],
  },
  {
    label: "Helper agents use",
    page: "models",
    anchor: "save-tokens",
    keywords: ["helper model", "subagent", "sub-agent", "sonnet", "haiku"],
  },
  { label: "Rate limits", page: "models", anchor: "rate-limits", keywords: ["failover", "limit", "resume"] },
  { label: "Budgets", page: "models", anchor: "budgets", keywords: ["spending limit", "cost", "money", "cap"] },
  {
    label: "Providers",
    page: "providers",
    keywords: ["claude", "codex", "grok", "install", "sign in", "cli"],
  },
  { label: "Agent tools", page: "providers", anchor: "tools", keywords: ["updates", "claude code", "codex"] },
  { label: "Custom agents", page: "providers", anchor: "agents", keywords: ["acp", "gemini", "goose"] },
  { label: "Project instructions", page: "projects", tab: "instructions", keywords: ["claude.md", "agents.md"] },
  { label: "MCP servers", page: "projects", tab: "mcp", keywords: ["mcp", "connectors", "tools"] },
  { label: "Skills", page: "projects", tab: "skills", keywords: ["skill.md"] },
  { label: "Permission rules", page: "projects", tab: "permissions", keywords: ["allow", "deny", "ask"] },
  { label: "Hooks and slash commands", page: "projects", tab: "automation", keywords: ["hooks", "commands"] },
  { label: "Templates", page: "templates", keywords: ["prompts", "snippets"] },
  {
    label: "Remote access",
    page: "remote",
    keywords: ["phone", "mobile", "lan", "tailscale", "port", "pairing", "qr", "devices", "share links"],
  },
  { label: "Phone push", page: "remote", anchor: "push", keywords: ["ntfy", "push", "notifications"] },
  { label: "Voice dictation", page: "voice", keywords: ["microphone", "speech", "dictate", "whisper"] },
  { label: "Voice assistant", page: "voice", anchor: "assistant", keywords: ["openai", "talk", "wake phrase"] },
  { label: "Copy diagnostics", page: "about", anchor: "diagnostics", keywords: ["bug", "logs", "report"] },
  { label: "Show the tour again", page: "about", anchor: "tour", keywords: ["welcome", "tour", "onboarding"] },
  { label: "About Kvistcode", page: "about", keywords: ["version", "github", "sponsor", "license"] },
];

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Entries matching a search: every word typed must start a word in the entry's name, page or
 * keywords. Matches in the name come first.
 */
export function searchSettings(query: string, limit = 8): SettingsEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const res = terms.map((t) => new RegExp(`(^|[^a-z0-9])${escapeRe(t)}`));
  const scored: { e: SettingsEntry; score: number }[] = [];
  SETTINGS_INDEX.forEach((e, i) => {
    const label = e.label.toLowerCase();
    const text = [label, PAGE_LABEL[e.page].toLowerCase(), ...(e.keywords ?? [])].join(" · ");
    if (!res.every((r) => r.test(text))) return;
    const inLabel = res.filter((r) => r.test(label)).length;
    scored.push({ e, score: inLabel * 1000 - i });
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}
