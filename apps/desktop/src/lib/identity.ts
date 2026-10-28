// Display identity for an agent's runtime: built-in providers, or a user-defined
// custom ACP agent (looked up by customAgentId).
import { PROVIDERS } from "./providers";
import type { CustomAgent, Provider } from "./types";

export interface Identity {
  provider: Provider;
  name: string;
  short: string;
  /** CSS color (variable for built-ins, hex for custom agents). */
  color: string;
  custom: CustomAgent | null;
}

export function identityFor(
  provider: Provider,
  customAgentId: string | null | undefined,
  customAgents: CustomAgent[] | undefined,
): Identity {
  if (provider === "custom") {
    const c = customAgents?.find((a) => a.id === customAgentId) ?? null;
    return {
      provider,
      name: c?.name ?? "Custom agent",
      short: c?.name ?? "Custom",
      color: c?.color ?? PROVIDERS.custom.colorVar,
      custom: c,
    };
  }
  const p = PROVIDERS[provider];
  return { provider, name: p.name, short: p.short, color: p.colorVar, custom: null };
}

/** One or two letters for a custom agent's monogram. */
export function monogram(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
