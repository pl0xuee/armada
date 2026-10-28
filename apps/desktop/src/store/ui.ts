import { create } from "zustand";
import type { Agent, Provider, Schedule } from "@/lib/types";

export type View =
  "agents" | "triage" | "mission" | "inbox" | "compare" | "schedules" | "usage" | "accounts" | "settings";

export type SettingsSection =
  | "appearance"
  | "sounds"
  | "notifications"
  | "behavior"
  | "templates"
  | "mcp"
  | "providers"
  | "agents"
  | "remote"
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
}

export interface NewAgentPreset {
  projectPath?: string;
  provider?: Provider;
  accountId?: string;
  prompt?: string;
  compare?: boolean;
}

interface UiStore {
  view: View;
  selectedAgentId: string | null;
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
  handoffAgent: Agent | null;
  deleteAgent: Agent | null;
  /** Agent being moved to another account. */
  moveAgent: Agent | null;
  /** Agent whose live view is being shared. */
  shareAgent: Agent | null;
  terminal: TerminalSession | null;
  windowFocused: boolean;
  /** Bumps to ask the composer to focus itself. */
  composerFocusTick: number;

  setView: (v: View) => void;
  openAgent: (id: string) => void;
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
  setHandoffAgent: (a: Agent | null) => void;
  setDeleteAgent: (a: Agent | null) => void;
  setMoveAgent: (a: Agent | null) => void;
  setShareAgent: (a: Agent | null) => void;
  setTerminal: (t: TerminalSession | null) => void;
  setWindowFocused: (f: boolean) => void;
  focusComposer: () => void;
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

const VIEWS: View[] = ["agents", "triage", "mission", "inbox", "compare", "schedules", "usage", "accounts", "settings"];

/** Dev/review convenience: ?view=mission&agent=<id> picks the initial screen. */
function initialFromUrl(): { view: View; agent: string | null } {
  try {
    const p = new URLSearchParams(location.search);
    const v = p.get("view") as View | null;
    return { view: v && VIEWS.includes(v) ? v : "agents", agent: p.get("agent") };
  } catch {
    return { view: "agents", agent: null };
  }
}

const initial = initialFromUrl();

export const useUi = create<UiStore>((set) => ({
  view: initial.view,
  selectedAgentId: initial.agent,
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
  handoffAgent: null,
  deleteAgent: null,
  moveAgent: null,
  shareAgent: null,
  terminal: null,
  windowFocused: typeof document !== "undefined" ? document.hasFocus() : true,
  composerFocusTick: 0,

  setView: (view) => set({ view }),
  openAgent: (id) => set({ view: "agents", selectedAgentId: id }),
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
  setHandoffAgent: (handoffAgent) => set({ handoffAgent }),
  setDeleteAgent: (deleteAgent) => set({ deleteAgent }),
  setMoveAgent: (moveAgent) => set({ moveAgent }),
  setShareAgent: (shareAgent) => set({ shareAgent }),
  setTerminal: (terminal) => set({ terminal }),
  setWindowFocused: (windowFocused) => set({ windowFocused }),
  focusComposer: () => set((s) => ({ composerFocusTick: s.composerFocusTick + 1 })),
}));
