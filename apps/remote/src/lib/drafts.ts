/** Unsent composer text per agent (localStorage, so it survives reloads). */
import { storage } from "./storage";

const PREFIX = "armada.draft.";
export const draftKey = (agentId: string) => `${PREFIX}${agentId}`;

/** The agent was removed: its draft is useless now. */
export function purgeDraft(agentId: string) {
  storage.remove(draftKey(agentId));
}

/** Other per-pairing choices kept on this device: the last project and the remembered "together" groups. */
const PAIRING_KEYS = ["armada.newAgent.last", "armada.together"];

/** Unpairing: drafts, and the project and agent ids remembered for that desktop, may be private; don't leave them behind. */
export function purgeAllDrafts() {
  for (const k of PAIRING_KEYS) storage.remove(k);
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    // storage unavailable
  }
}
