// What the voice assistant "sees", in words, for the panel's "Sees:" row. Pure, so it is unit-tested.
// Built from the same screen context the store reports, plus the open agent's title and folder.
import type { ScreenContext } from "@/lib/screenContext";
import { basename } from "@/lib/utils";

export interface SeenAgent {
  title: string;
  projectPath: string;
}

export interface ScreenDescription {
  /** Short text for the row (long titles cut with an ellipsis). */
  label: string;
  /** Full text for the tooltip. */
  full: string;
  /** "+2 side by side" when several agents are shown together. */
  together: string | null;
}

const SCREEN_NAME: Record<string, string> = {
  agents: "Agents",
  mission: "Mission Control",
  compare: "Compare",
  schedules: "Schedules",
  usage: "Usage",
  accounts: "Accounts",
  settings: "Settings",
};

export const MAX_SEEN_TITLE = 36;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * `agents`: the agents by id (only title and folder are read). `shownTogether`: the ids in the grid on the
 * Agents page, if any (the open agent is one of them), or how many there are.
 */
export function describeScreen(
  ctx: Pick<ScreenContext, "view" | "agentId">,
  agents: Readonly<Record<string, SeenAgent | undefined>>,
  shownTogether: readonly string[] | number | null = null,
): ScreenDescription {
  if (ctx.view === "agents" && ctx.agentId) {
    const agent = agents[ctx.agentId];
    if (!agent) return { label: "an agent that is gone", full: "The open agent is no longer there", together: null };
    const folder = agent.projectPath ? basename(agent.projectPath) : "";
    const full = folder ? `${agent.title} · ${folder}` : agent.title;
    const label = folder
      ? `${cut(agent.title, MAX_SEEN_TITLE)} · ${cut(folder, MAX_SEEN_TITLE)}`
      : cut(agent.title, 60);
    const others =
      typeof shownTogether === "number"
        ? Math.max(0, shownTogether - 1)
        : (shownTogether ?? []).filter((id) => id !== ctx.agentId).length;
    return { label, full, together: others > 0 ? `+${others} side by side` : null };
  }
  const name = SCREEN_NAME[ctx.view] ?? ctx.view;
  return { label: name, full: name, together: null };
}
