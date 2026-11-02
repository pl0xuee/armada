/**
 * Whether an agent's cost is a bill. Accounts that sign in with a subscription (Claude Max, ChatGPT Pro, ...) aren't
 * charged per token: the figure is what the same usage would cost through the API. The desktop's
 * `costIsEquivalent` says so next to every cost; this is the phone's copy. Only said when the server told us
 * the account's kind (a share link has no accounts, an older server doesn't send it): never guessed.
 */
import type { Agent, RemoteAccount } from "./types";

export const EQUIVALENT_NOTE = "API-equivalent, not a bill";

export function costIsEquivalent(agent: Pick<Agent, "provider">, account: Pick<RemoteAccount, "authKind"> | undefined): boolean {
  return agent.provider !== "local" && account?.authKind !== undefined && account.authKind !== "api_key";
}
