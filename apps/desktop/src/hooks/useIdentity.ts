import { identityFor, type Identity } from "@/lib/identity";
import type { Provider } from "@/lib/types";
import { useApp } from "@/store/app";

/** Name/color for a provider, resolving custom ACP agents by id. */
export function useIdentity(provider: Provider, customAgentId?: string | null): Identity {
  const customAgents = useApp((s) => s.settings?.customAgents);
  return identityFor(provider, customAgentId, customAgents);
}
