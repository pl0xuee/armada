// What the window shows, reported to the voice assistant so the user needn't say it ("this agent", "the
// highlighted text"). Pure, so it is unit-tested; the store pushes it (store/voiceAssistant.ts).
import type { View } from "@/store/ui";

export interface ScreenContext {
  view: View;
  agentId: string | null;
  settingsSection: string | null;
  missionTab: string | null;
  reviewAgentId: string | null;
  selectedText: string | null;
}

/** Highlighted text is cut here, and only what the assistant asks for is sent on to OpenAI. */
export const MAX_SELECTION = 500;

interface UiLike {
  view: View;
  selectedAgentId: string | null;
  settingsSection: string;
  missionTab: string | null;
  reviewAgentId: string | null;
}

export function screenContextOf(ui: UiLike, selection: string | null | undefined): ScreenContext {
  const text = (selection ?? "").replace(/\s+/g, " ").trim();
  return {
    view: ui.view,
    // The agent only counts on the screen that shows it.
    agentId: ui.view === "agents" ? ui.selectedAgentId : null,
    settingsSection: ui.view === "settings" ? ui.settingsSection : null,
    missionTab: ui.view === "mission" ? ui.missionTab : null,
    reviewAgentId: ui.reviewAgentId,
    selectedText: text ? text.slice(0, MAX_SELECTION) : null,
  };
}
