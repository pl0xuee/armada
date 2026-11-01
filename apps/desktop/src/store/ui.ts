import { create } from "zustand";
import { PREVIEW_DEFAULT_WIDTH } from "@/lib/layout";
import { createCoalescedWriter } from "@/lib/throttle";
import type { Agent, Provider, Schedule } from "@/lib/types";

export type View = "agents" | "mission" | "compare" | "schedules" | "usage" | "accounts" | "settings";

/** Mission Control's two lenses on the fleet: the agents that need you, and every agent. */
export type MissionTab = "needs" | "all";

export type SettingsSection =
  | "appearance"
  | "sounds"
  | "notifications"
  | "behavior"
  | "budgets"
  | "templates"
  | "projects"
  | "mcp"
  | "providers"
  | "tools"
  | "agents"
  | "remote"
  | "voice"
  | "assistant"
  | "about";

export interface TerminalSession {
  terminalId: string;
  title: string;
  subtitle?: string;
  /** What to do once the process exits. */
  kind: "login" | "install";
  accountId?: string;
  provider?: Provider;
  /** The core reused a sign-in that was already running (its earlier output isn't replayed). */
  reused?: boolean;
  /** The program that was started (shown when it prints nothing for a while). */
  command?: string;
  /** A GitHub sign-in (`gh auth login`), not an agent account's. */
  github?: boolean;
}

export interface NewAgentPreset {
  projectPath?: string;
  provider?: Provider;
  accountId?: string;
  prompt?: string;
  compare?: boolean;
  /** Title for the agent, and whether it starts in its own worktree (an issue's agent does). */
  title?: string;
  worktree?: boolean;
}

interface UiStore {
  view: View;
  /** Which Mission Control tab is showing. null: not chosen yet, so the view picks one when it opens. */
  missionTab: MissionTab | null;
  selectedAgentId: string | null;
  /** Agents shown together in a grid on the Agents page (the open agent is one of them). null: just the open agent. */
  tileGroup: string[] | null;
  compareGroupId: string | null;
  settingsSection: SettingsSection;
  inspectorOpen: boolean;
  /** Inspector shown as an overlay on narrow windows. */
  inspectorOverlay: boolean;
  /** Agent list visibility, remembered separately for wide (docked) and narrow (drawer) layouts. */
  agentList: { wide: boolean; narrow: boolean };
  reviewAgentId: string | null;
  /** File to focus when the review sheet opens (from a turn-summary chip). */
  reviewFile: string | null;
  /** Open the review sheet straight into a flow (e.g. the PR form). */
  reviewIntent: "pr" | null;
  /** Prefill for the schedule editor ("Schedule this" from an agent); consumed by the Schedules view. */
  schedulePrefill: Partial<Schedule> | null;
  paletteOpen: boolean;
  newAgent: { open: boolean; preset: NewAgentPreset | null };
  /** GitHub issues of a project, from which an agent can be started. */
  issues: { open: boolean; projectPath: string | null };
  handoffAgent: Agent | null;
  deleteAgent: Agent | null;
  /** Agent being moved to another account. */
  moveAgent: Agent | null;
  /** Agent whose live view is being shared. */
  shareAgent: Agent | null;
  terminal: TerminalSession | null;
  windowFocused: boolean;
  /** Workspace panel (terminals, scripts) under the conversation; remembered across restarts. */
  workspaceOpen: boolean;
  workspaceHeight: number;
  /** Tallest the workspace panel can be right now (0 = the window is too small for it). Not persisted. */
  workspaceRoom: number;
  setWorkspaceRoom: (px: number) => void;
  /** Width of the right-side Preview pane (clamped to the room at layout time); remembered across restarts. */
  previewWidth: number;
  /** Show a main agent and its helpers side by side. */
  tileHelpers: boolean;
  setTileHelpers: (on: boolean) => void;
  setPreviewWidth: (px: number) => void;
  /** Bumps to ask the composer to focus itself. */
  composerFocusTick: number;
  /** A timeline item to scroll into view once its agent's timeline is showing (see `revealItem`). */
  revealTarget: { agentId: string; itemId: string; tick: number } | null;

  setView: (v: View) => void;
  /** Open Mission Control on a tab. */
  openMission: (tab: MissionTab) => void;
  openAgent: (id: string) => void;
  /** Show several agents together in a grid (and focus one of them). */
  openAgents: (ids: string[], focusId?: string) => void;
  /** Open an agent and scroll its timeline to one item (e.g. a sub-agent's card). */
  revealItem: (agentId: string, itemId: string) => void;
  clearRevealTarget: () => void;
  openCompare: (groupId: string | null) => void;
  openSettings: (section?: SettingsSection) => void;
  setInspectorOpen: (open: boolean) => void;
  setInspectorOverlay: (open: boolean) => void;
  setAgentList: (layout: "wide" | "narrow", open: boolean) => void;
  setReviewAgent: (id: string | null, file?: string | null, intent?: "pr" | null) => void;
  openScheduleFor: (prefill: Partial<Schedule>) => void;
  clearSchedulePrefill: () => void;
  setPaletteOpen: (open: boolean) => void;
  openNewAgent: (preset?: NewAgentPreset) => void;
  closeNewAgent: () => void;
  openIssues: (projectPath: string) => void;
  closeIssues: () => void;
  setHandoffAgent: (a: Agent | null) => void;
  setDeleteAgent: (a: Agent | null) => void;
  setMoveAgent: (a: Agent | null) => void;
  setShareAgent: (a: Agent | null) => void;
  setTerminal: (t: TerminalSession | null) => void;
  setWindowFocused: (f: boolean) => void;
  focusComposer: () => void;
  setWorkspaceOpen: (open: boolean) => void;
  setWorkspaceHeight: (px: number) => void;
}

const WORKSPACE_KEY = "armada.workspace";
export const WORKSPACE_MIN_HEIGHT = 120;
export const WORKSPACE_DEFAULT_HEIGHT = 280;

function readWorkspace(): { open: boolean; height: number } {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<{ open: boolean; height: number }>;
      const h = typeof v.height === "number" && Number.isFinite(v.height) ? v.height : WORKSPACE_DEFAULT_HEIGHT;
      return { open: v.open === true, height: Math.max(WORKSPACE_MIN_HEIGHT, Math.min(2000, Math.round(h))) };
    }
  } catch {
    /* ignore */
  }
  return { open: false, height: WORKSPACE_DEFAULT_HEIGHT };
}

function saveWorkspace(open: boolean, height: number) {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ open, height }));
  } catch {
    /* ignore */
  }
}

const PREVIEW_WIDTH_KEY = "armada.previewWidth";

function readPreviewWidth(): number {
  try {
    const n = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
    if (Number.isFinite(n) && n > 0) return Math.min(4000, Math.round(n));
  } catch {
    /* ignore */
  }
  return PREVIEW_DEFAULT_WIDTH;
}

const TILE_KEY = "armada.tileHelpers";

function readTileHelpers(): boolean {
  try {
    return localStorage.getItem(TILE_KEY) !== "0";
  } catch {
    return true;
  }
}

const TILE_WEIGHTS_KEY = "armada.tileWeights";
const WEIGHT_MIN = 1; // weights are tile widths in px
const WEIGHT_MAX = 10000;

function readAllTileWeights(): Record<string, Record<string, number>> {
  try {
    const v = JSON.parse(localStorage.getItem(TILE_WEIGHTS_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Saved tile divider weights for a main agent's group; only ids in `ids`, clamped to a sane range. */
export function readTileWeights(mainId: string, ids: readonly string[]): Record<string, number> {
  tileWeightsWriter.flush(); // a save still waiting for its 150 ms is part of what was saved
  const saved = readAllTileWeights()[mainId];
  const out: Record<string, number> = {};
  if (!saved || typeof saved !== "object") return out;
  for (const id of ids) {
    const w = (saved as Record<string, unknown>)[id];
    if (typeof w === "number" && Number.isFinite(w)) out[id] = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));
  }
  return out;
}

// Dragging a divider saves on every pointermove; write the latest weights once the drag settles.
const tileWeightsWriter = createCoalescedWriter<string, Record<string, number>>(150, (entries) => {
  try {
    const all = readAllTileWeights();
    for (const [mainId, weights] of entries) {
      if (Object.keys(weights).length) all[mainId] = weights;
      else delete all[mainId];
    }
    localStorage.setItem(TILE_WEIGHTS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
});
if (typeof window !== "undefined") window.addEventListener("pagehide", tileWeightsWriter.flush);

/** Persist a group's weights (empty removes the entry). Written shortly after the last call. */
export function saveTileWeights(mainId: string, weights: Record<string, number>) {
  tileWeightsWriter.set(mainId, weights);
}

const INSPECTOR_KEY = "armada.inspectorOpen";
const LIST_KEY = "armada.agentList";

function readAgentList(): { wide: boolean; narrow: boolean } {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<{ wide: boolean; narrow: boolean }>;
      return { wide: v.wide !== false, narrow: v.narrow === true };
    }
  } catch {
    /* ignore */
  }
  return { wide: true, narrow: false };
}

function readInspector(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_KEY) !== "0";
  } catch {
    return true;
  }
}

const VIEWS: View[] = ["agents", "mission", "compare", "schedules", "usage", "accounts", "settings"];

/**
 * A `?view=` value as a view plus (for Mission Control) the tab it implies. "triage" and "inbox" are the
 * names of the views Mission Control replaced; old links and bookmarks keep opening its Needs you tab.
 */
export function viewFromUrl(name: string | null): { view: View; tab: MissionTab | null } | null {
  if (name === "triage" || name === "inbox") return { view: "mission", tab: "needs" };
  return name && (VIEWS as string[]).includes(name) ? { view: name as View, tab: null } : null;
}

/** Dev/review convenience: ?view=mission&tab=needs&agent=<id> picks the initial screen. */
function initialFromUrl(): { view: View; tab: MissionTab | null; agent: string | null } {
  try {
    const p = new URLSearchParams(location.search);
    const r = viewFromUrl(p.get("view"));
    const tab = p.get("tab");
    return {
      view: r?.view ?? "agents",
      tab: tab === "needs" || tab === "all" ? tab : (r?.tab ?? null),
      agent: p.get("agent"),
    };
  } catch {
    return { view: "agents", tab: null, agent: null };
  }
}

const initial = initialFromUrl();

export const useUi = create<UiStore>((set) => ({
  view: initial.view,
  missionTab: initial.tab,
  selectedAgentId: initial.agent,
  tileGroup: null,
  compareGroupId: null,
  settingsSection: "appearance",
  inspectorOpen: readInspector(),
  inspectorOverlay: false,
  agentList: readAgentList(),
  reviewAgentId: null,
  reviewFile: null,
  reviewIntent: null,
  schedulePrefill: null,
  paletteOpen: false,
  newAgent: { open: false, preset: null },
  issues: { open: false, projectPath: null },
  handoffAgent: null,
  deleteAgent: null,
  moveAgent: null,
  shareAgent: null,
  terminal: null,
  windowFocused: typeof document !== "undefined" ? document.hasFocus() : true,
  composerFocusTick: 0,
  revealTarget: null,
  workspaceOpen: readWorkspace().open,
  workspaceHeight: readWorkspace().height,
  workspaceRoom: 1000,
  previewWidth: readPreviewWidth(),
  tileHelpers: readTileHelpers(),
  setTileHelpers: (tileHelpers) => {
    try {
      localStorage.setItem(TILE_KEY, tileHelpers ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ tileHelpers });
  },
  setPreviewWidth: (w) => {
    const previewWidth = Math.min(4000, Math.max(1, Math.round(w)));
    try {
      localStorage.setItem(PREVIEW_WIDTH_KEY, String(previewWidth));
    } catch {
      /* ignore */
    }
    set({ previewWidth });
  },
  setWorkspaceRoom: (workspaceRoom) => set((s) => (s.workspaceRoom === workspaceRoom ? s : { workspaceRoom })),

  setView: (view) => {
    if (!VIEWS.includes(view)) return;
    // Arriving from elsewhere re-picks the tab; clicking Mission Control while on it keeps yours.
    set((s) => ({ view, missionTab: view === "mission" && s.view !== "mission" ? null : s.missionTab }));
  },
  openMission: (missionTab) => set({ view: "mission", missionTab }),
  // Opening one of the agents already shown together just moves focus; anything else leaves the grid.
  openAgent: (id) =>
    set((s) => ({ view: "agents", selectedAgentId: id, tileGroup: s.tileGroup?.includes(id) ? s.tileGroup : null })),
  openAgents: (ids, focusId) => {
    const group = [...new Set(ids)];
    set({
      view: "agents",
      selectedAgentId: focusId && group.includes(focusId) ? focusId : (group[0] ?? null),
      tileGroup: group.length > 1 ? group : null,
    });
  },
  revealItem: (agentId, itemId) =>
    set((s) => ({
      view: "agents",
      selectedAgentId: agentId,
      tileGroup: s.tileGroup?.includes(agentId) ? s.tileGroup : null,
      revealTarget: { agentId, itemId, tick: (s.revealTarget?.tick ?? 0) + 1 },
    })),
  clearRevealTarget: () => set({ revealTarget: null }),
  openCompare: (compareGroupId) => set({ view: "compare", compareGroupId }),
  openSettings: (section) => set((s) => ({ view: "settings", settingsSection: section ?? s.settingsSection })),
  setInspectorOpen: (inspectorOpen) => {
    try {
      localStorage.setItem(INSPECTOR_KEY, inspectorOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ inspectorOpen });
  },
  setInspectorOverlay: (inspectorOverlay) => set({ inspectorOverlay }),
  setAgentList: (layout, open) =>
    set((s) => {
      const agentList = { ...s.agentList, [layout]: open };
      try {
        localStorage.setItem(LIST_KEY, JSON.stringify(agentList));
      } catch {
        /* ignore */
      }
      return { agentList };
    }),
  setReviewAgent: (reviewAgentId, file = null, intent = null) =>
    set({ reviewAgentId, reviewFile: reviewAgentId ? file : null, reviewIntent: reviewAgentId ? intent : null }),
  openScheduleFor: (schedulePrefill) => set({ schedulePrefill, view: "schedules" }),
  clearSchedulePrefill: () => set({ schedulePrefill: null }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  openNewAgent: (preset) => set({ newAgent: { open: true, preset: preset ?? null } }),
  closeNewAgent: () => set((s) => ({ newAgent: { ...s.newAgent, open: false } })),
  openIssues: (projectPath) => set({ issues: { open: true, projectPath } }),
  closeIssues: () => set((s) => ({ issues: { ...s.issues, open: false } })),
  setHandoffAgent: (handoffAgent) => set({ handoffAgent }),
  setDeleteAgent: (deleteAgent) => set({ deleteAgent }),
  setMoveAgent: (moveAgent) => set({ moveAgent }),
  setShareAgent: (shareAgent) => set({ shareAgent }),
  setTerminal: (terminal) => set({ terminal }),
  setWindowFocused: (windowFocused) => set({ windowFocused }),
  focusComposer: () => set((s) => ({ composerFocusTick: s.composerFocusTick + 1 })),
  setWorkspaceOpen: (workspaceOpen) => {
    saveWorkspace(workspaceOpen, useUi.getState().workspaceHeight);
    set({ workspaceOpen });
  },
  setWorkspaceHeight: (h) => {
    const workspaceHeight = Math.max(WORKSPACE_MIN_HEIGHT, Math.round(h));
    saveWorkspace(useUi.getState().workspaceOpen, workspaceHeight);
    set({ workspaceHeight });
  },
}));
