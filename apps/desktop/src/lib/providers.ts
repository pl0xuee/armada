import type { AgentStatus, Provider } from "./types";

export interface ProviderMeta {
  id: Provider;
  name: string;
  short: string;
  vendor: string;
  /** CSS variable holding the identity color (theme aware). */
  colorVar: string;
  /** Raw hex, for places that need a literal value (SVG gradients). */
  hex: string;
  tagline: string;
}

/** The three first-party runtimes (custom ACP agents are configured by the user). */
export type BuiltinProvider = Exclude<Provider, "custom">;

export const PROVIDERS: Record<Provider, ProviderMeta> = {
  claude: {
    id: "claude",
    name: "Claude",
    short: "Claude",
    vendor: "Anthropic",
    colorVar: "var(--claude)",
    hex: "#D97757",
    tagline: "Claude Code",
  },
  codex: {
    id: "codex",
    name: "ChatGPT (Codex)",
    short: "Codex",
    vendor: "OpenAI",
    colorVar: "var(--openai)",
    hex: "#10A37F",
    tagline: "Codex CLI",
  },
  grok: {
    id: "grok",
    name: "Grok",
    short: "Grok",
    vendor: "xAI",
    colorVar: "var(--grok)",
    hex: "#E5E7EB",
    tagline: "Grok Build",
  },
  custom: {
    id: "custom",
    name: "Custom agent",
    short: "Custom",
    vendor: "ACP",
    colorVar: "var(--violet)",
    hex: "#A78BFA",
    tagline: "Any ACP agent",
  },
};

export const PROVIDER_ORDER: BuiltinProvider[] = ["claude", "codex", "grok"];

export const CUSTOM_ACCOUNT_ID = "system-custom";

/** Sort key: built-ins in their usual order, custom agents last. */
export function providerRank(p: Provider): number {
  const i = (PROVIDER_ORDER as Provider[]).indexOf(p);
  return i < 0 ? PROVIDER_ORDER.length : i;
}

export interface StatusMeta {
  label: string;
  colorVar: string;
  /** Live states get pulse + glow. */
  live: boolean;
}

/** Presentation for an idle agent whose last turn just completed. */
export const DONE_META: StatusMeta = { label: "Done", colorVar: "var(--ok)", live: false };

export const STATUS: Record<AgentStatus, StatusMeta> = {
  starting: { label: "Starting", colorVar: "var(--accent)", live: true },
  working: { label: "Working", colorVar: "var(--accent)", live: true },
  needs_permission: { label: "Needs approval", colorVar: "var(--warn)", live: true },
  idle: { label: "Idle", colorVar: "var(--steel)", live: false },
  error: { label: "Error", colorVar: "var(--err)", live: false },
  interrupted: { label: "Interrupted", colorVar: "var(--violet)", live: false },
  stopped: { label: "Stopped", colorVar: "color-mix(in srgb, var(--steel) 55%, transparent)", live: false },
};

export const ACCOUNT_COLORS = [
  "#4FC3F7",
  "#D97757",
  "#10A37F",
  "#A78BFA",
  "#F5B544",
  "#F472B6",
  "#3DDC97",
  "#E5E7EB",
  "#FF5C6C",
  "#7D8B99",
];
