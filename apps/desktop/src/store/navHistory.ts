import { create } from "zustand";
import { useApp } from "./app";
import { useUi, type MissionTab, type SettingsSection, type View } from "./ui";

/** Where the user is: what Back and Forward step between. */
export interface Place {
  view: View;
  agentId: string | null;
  tileGroup: string[] | null;
  missionTab: MissionTab | null;
  settingsSection: SettingsSection;
  compareGroupId: string | null;
}

/** Enough to get back to anywhere from the last while, without growing for ever. */
export const NAV_LIMIT = 50;

interface NavState {
  back: Place[];
  forward: Place[];
}

export const useNav = create<NavState>(() => ({ back: [], forward: [] }));

type UiState = ReturnType<typeof useUi.getState>;

export function placeOf(s: UiState): Place {
  return {
    view: s.view,
    agentId: s.selectedAgentId,
    tileGroup: s.tileGroup,
    missionTab: s.missionTab,
    settingsSection: s.settingsSection,
    compareGroupId: s.compareGroupId,
  };
}

/** Two places are the same stop when what the view shows is the same (other views' leftovers don't count). */
export function samePlace(a: Place, b: Place): boolean {
  if (a.view !== b.view) return false;
  switch (a.view) {
    case "agents":
      return a.agentId === b.agentId && (a.tileGroup ?? []).join("\n") === (b.tileGroup ?? []).join("\n");
    case "mission":
      return a.missionTab === b.missionTab;
    case "settings":
      return a.settingsSection === b.settingsSection;
    case "compare":
      return a.compareGroupId === b.compareGroupId;
    default:
      return true;
  }
}

let current: Place | null = null;
let queued = false;

function record() {
  queued = false;
  const next = placeOf(useUi.getState());
  const prev = current;
  current = next;
  if (!prev || samePlace(prev, next)) return;
  // Mission Control picks its own tab when it opens: that settles the stop, it isn't a new one.
  if (prev.view === "mission" && next.view === "mission" && prev.missionTab === null) return;
  useNav.setState((s) => ({ back: [...s.back, prev].slice(-NAV_LIMIT), forward: [] }));
}

/** Starts recording where the user goes. Returns the uninstaller. */
export function installNavHistory(): () => void {
  current = placeOf(useUi.getState());
  useNav.setState({ back: [], forward: [] });
  const off = useUi.subscribe(() => {
    // Several updates from one click (a view, then its agent) are one step.
    if (queued) return;
    queued = true;
    queueMicrotask(record);
  });
  return () => {
    off();
    current = null;
    queued = false;
  };
}

/** A place can still be shown: its agent (and the agents tiled with it) still exist. */
function reachable(p: Place): Place | null {
  if (p.view !== "agents" || !p.agentId) return p;
  const agents = useApp.getState().agents;
  if (!agents[p.agentId]) return null;
  const group = p.tileGroup?.filter((id) => agents[id]) ?? null;
  return { ...p, tileGroup: group && group.length > 1 ? group : null };
}

function show(p: Place) {
  const patch: Partial<UiState> = { view: p.view };
  if (p.view === "agents") {
    patch.selectedAgentId = p.agentId;
    patch.tileGroup = p.tileGroup;
  } else if (p.view === "mission") patch.missionTab = p.missionTab;
  else if (p.view === "settings") patch.settingsSection = p.settingsSection;
  else if (p.view === "compare") patch.compareGroupId = p.compareGroupId;
  useUi.setState(patch);
  // The subscriber's pending check compares against this, so the step itself isn't recorded.
  current = placeOf(useUi.getState());
}

function step(dir: "back" | "forward"): boolean {
  if (!current) return false;
  record();
  const s = useNav.getState();
  const from = [...s[dir]];
  const to = [...s[dir === "back" ? "forward" : "back"]];
  const here = current;
  while (from.length > 0) {
    const target = reachable(from.pop()!);
    if (!target || samePlace(target, here)) continue;
    to.push(here);
    show(target);
    useNav.setState(dir === "back" ? { back: from, forward: to } : { back: to, forward: from });
    return true;
  }
  useNav.setState(dir === "back" ? { back: from } : { forward: from });
  return false;
}

export const goBack = () => step("back");
export const goForward = () => step("forward");

/** The name of a place, for "Back to …" tooltips. */
export function placeLabel(p: Place): string {
  switch (p.view) {
    case "agents": {
      const agent = p.agentId ? useApp.getState().agents[p.agentId] : undefined;
      return agent?.title || "Projects";
    }
    case "mission":
      return p.missionTab === "all" ? "Mission Control: All agents" : "Mission Control: Needs you";
    case "compare":
      return "Compare";
    case "schedules":
      return "Schedules";
    case "usage":
      return "Usage";
    case "accounts":
      return "Accounts";
    case "settings":
      return "Settings";
  }
}
