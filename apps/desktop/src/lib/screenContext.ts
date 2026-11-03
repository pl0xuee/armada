// What the window shows, reported to the voice assistant so the user needn't say it ("this agent", "the
// highlighted text"). Pure, so it is unit-tested; the store pushes it (store/voiceAssistant.ts).
import type { View } from "@/store/ui";

export interface ScreenContext {
  view: View;
  agentId: string | null;
  settingsSection: string | null;
  missionTab: string | null;
  reviewAgentId: string | null;
  /** The Compare screen's open group. */
  compareGroupId: string | null;
  selectedText: string | null;
  /** The agents on screen together (tiles side by side), the open one included; empty with a single agent. */
  shownAgentIds: string[];
  /** The ids of the agents that are not archived, in the sidebar's order: how the assistant numbers them. */
  agentOrder: string[];
}

/** Highlighted text is cut here, and only what the assistant asks for is sent on to OpenAI. */
export const MAX_SELECTION = 500;

interface UiLike {
  view: View;
  selectedAgentId: string | null;
  settingsSection: string;
  missionTab: string | null;
  reviewAgentId: string | null;
  compareGroupId?: string | null;
}

/** Most ids sent (more agents than a person keeps open); the backend caps it too. */
export const MAX_ORDER = 200;

export function screenContextOf(
  ui: UiLike,
  selection: string | null | undefined,
  agentOrder: readonly string[] = [],
  shownAgentIds: readonly string[] = [],
): ScreenContext {
  const text = (selection ?? "").replace(/\s+/g, " ").trim();
  return {
    view: ui.view,
    // The agent only counts on the screen that shows it.
    agentId: ui.view === "agents" ? ui.selectedAgentId : null,
    settingsSection: ui.view === "settings" ? ui.settingsSection : null,
    missionTab: ui.view === "mission" ? ui.missionTab : null,
    reviewAgentId: ui.reviewAgentId,
    compareGroupId: ui.view === "compare" ? (ui.compareGroupId ?? null) : null,
    shownAgentIds: ui.view === "agents" && shownAgentIds.length > 1 ? shownAgentIds.slice(0, 8) : [],
    selectedText: text ? text.slice(0, MAX_SELECTION) : null,
    agentOrder: agentOrder.slice(0, MAX_ORDER),
  };
}
