import type { Account, Agent } from "./types";

/**
 * Split agent cost into what was actually billed (API-key accounts, charged per token) and the
 * API-equivalent value of subscription usage (Claude Max, ChatGPT Pro, …), which isn't billed per token.
 */
export function splitCost(agents: Agent[], accounts: Account[]): { billed: number; equivalent: number } {
  const apiKey = new Set(accounts.filter((a) => a.authKind === "api_key").map((a) => a.id));
  let billed = 0;
  let equivalent = 0;
  for (const a of agents) {
    if (apiKey.has(a.accountId)) billed += a.costUsd;
    else equivalent += a.costUsd;
  }
  return { billed, equivalent };
}
