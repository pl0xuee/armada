/**
 * "Open this search result in its conversation": a tapped hit hands its item to the agent screen, which
 * loads back to it and scrolls there. A one-shot hand-off (like `reviewFocus`) so the routes and URLs stay as
 * they are. The desktop does the same from its search results.
 */
export interface SearchFocus {
  agentId: string;
  itemId: string;
  /** Its place in the agent's timeline: how far back the conversation has to be loaded. */
  seq: number;
}

let pending: SearchFocus | null = null;

export function setSearchFocus(focus: SearchFocus) {
  pending = focus;
}

/** The hit waiting to be shown for this agent (stays until `clearSearchFocus`, so a re-render can't lose it). */
export function peekSearchFocus(agentId: string): SearchFocus | null {
  return pending && pending.agentId === agentId ? pending : null;
}

export function clearSearchFocus() {
  pending = null;
}

/** Most pages of earlier messages fetched on the way to a hit (200 items each), so a bad seq can't loop. */
export const MAX_FOCUS_PAGES = 30;
