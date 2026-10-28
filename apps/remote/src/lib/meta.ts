import { confirmAction } from "./confirm";
import type { Agent, AgentStatus, PermissionItem, PermissionOption, Provider, RemoteCustomAgent } from "./types";

export interface ProviderMeta {
  name: string;
  short: string;
  color: string;
}

export const CUSTOM_AGENT_COLOR = "#B39DDB";

export const PROVIDERS: Record<Provider, ProviderMeta> = {
  claude: { name: "Claude", short: "Claude", color: "#D97757" },
  codex: { name: "ChatGPT (Codex)", short: "Codex", color: "#10A37F" },
  grok: { name: "Grok", short: "Grok", color: "#E5E7EB" },
  local: { name: "Local model", short: "Local", color: "#4FC3F7" },
  custom: { name: "Custom agent", short: "Agent", color: CUSTOM_AGENT_COLOR },
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Identity (name, color, monogram letter) for an agent's provider. */
export function agentIdentity(agent: Pick<Agent, "provider" | "customAgentId">, customAgents: Record<string, RemoteCustomAgent>) {
  const provider: Provider = agent.provider in PROVIDERS ? agent.provider : "custom";
  const base = PROVIDERS[provider];
  if (provider === "custom") {
    const def = agent.customAgentId ? customAgents[agent.customAgentId] : undefined;
    const name = def?.name || base.name;
    return {
      provider,
      name,
      short: def?.name || base.short,
      color: def?.color && HEX.test(def.color) ? def.color : CUSTOM_AGENT_COLOR,
      letter: (def?.name.trim()[0] ?? "A").toUpperCase(),
    };
  }
  return { provider, name: base.name, short: base.short, color: base.color, letter: base.short[0] };
}

export function safeColor(color: string | null | undefined, fallback = "#7D8B99"): string {
  return color && HEX.test(color) ? color : fallback;
}

export interface StatusMeta {
  label: string;
  color: string;
  /** Animated (pulse + glow). */
  live: boolean;
}

export const STATUS: Record<AgentStatus, StatusMeta> = {
  starting: { label: "Starting", color: "var(--accent)", live: true },
  working: { label: "Working", color: "var(--accent)", live: true },
  needs_permission: { label: "Needs approval", color: "var(--warn)", live: true },
  idle: { label: "Idle", color: "var(--steel)", live: false },
  error: { label: "Error", color: "var(--err)", live: false },
  interrupted: { label: "Interrupted", color: "var(--violet)", live: false },
  stopped: { label: "Stopped", color: "var(--steel)", live: false },
};

export function statusMeta(status: AgentStatus): StatusMeta {
  return STATUS[status] ?? STATUS.idle;
}

export function isBusy(status: AgentStatus) {
  return status === "working" || status === "starting" || status === "needs_permission";
}

export function isResumable(status: AgentStatus) {
  return status === "interrupted" || status === "stopped";
}

export function isAllow(o: PermissionOption) {
  return o.kind === "allow_once" || o.kind === "allow_always";
}

/**
 * The one-shot options, which are the only ones bound to the inbox's generic
 * "Approve"/"Deny" buttons and swipes (a swipe must never grant "always").
 */
export function allowOnce(item: PermissionItem): PermissionOption | null {
  return item.options.find((o) => o.kind === "allow_once") ?? null;
}

export function rejectOnce(item: PermissionItem): PermissionOption | null {
  return item.options.find((o) => o.kind === "reject_once") ?? null;
}

/** First allow option, preferring allow_once (timeline buttons show its real name). */
export function primaryAllow(item: PermissionItem): PermissionOption | null {
  return item.options.find((o) => o.kind === "allow_once") ?? item.options.find(isAllow) ?? null;
}

/** The option behind the big "Deny" button: first reject_once, else first reject. */
export function primaryReject(item: PermissionItem): PermissionOption | null {
  return (
    item.options.find((o) => o.kind === "reject_once") ?? item.options.find((o) => !isAllow(o)) ?? null
  );
}

export const isAlways = (o: PermissionOption) => o.kind === "allow_always" || o.kind === "reject_always";

/**
 * Swiping answers without looking at the details, so only allow it for small,
 * self-explanatory requests: no file changes, and a short one-line command.
 */
export function swipeable(item: PermissionItem): boolean {
  if (item.diffs.length) return false;
  const cmd = item.command ?? "";
  return cmd.length <= 80 && !cmd.includes("\n");
}

/** Confirm before an "always" answer (it changes future behaviour). */
export async function confirmOption(o: PermissionOption): Promise<boolean> {
  if (!isAlways(o)) return true;
  return confirmAction({
    title: o.name,
    body:
      o.kind === "allow_always"
        ? "The agent won't ask again for requests like this one in this session."
        : "Requests like this one will be denied without asking for the rest of this session.",
    confirmLabel: o.kind === "allow_always" ? "Always allow" : "Always deny",
    destructive: o.kind === "reject_always",
  });
}

export const OPTION_HINT: Record<PermissionOption["kind"], string> = {
  allow_once: "Allow this request only",
  allow_always: "Don't ask again for requests like this",
  reject_once: "Deny this request; the agent may try something else",
  reject_always: "Deny and don't ask again for requests like this",
};

export const RESOLVED_LABEL: Record<PermissionOption["kind"], string> = {
  allow_once: "Allowed once",
  allow_always: "Always allowed",
  reject_once: "Denied",
  reject_always: "Always denied",
};
