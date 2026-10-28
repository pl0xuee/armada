/** Unsent composer text per agent (localStorage, so it survives reloads). */
import { storage } from "./storage";

const PREFIX = "armada.draft.";
export const draftKey = (agentId: string) => `${PREFIX}${agentId}`;

/** The agent was removed: its draft is useless now. */
export function purgeDraft(agentId: string) {
  storage.remove(draftKey(agentId));
}

/** Unpairing: drafts may mention private work, don't leave them behind. */
export function purgeAllDrafts() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    // storage unavailable
  }
}
