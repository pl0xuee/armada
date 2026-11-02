import { toast } from "sonner";
import { create } from "zustand";
import { api, onVaEvent } from "@/lib/api";
import { beginVa, initialVa, isLive, reduceVa, type VaEvent, type VaState } from "@/lib/voiceAssistant";
import { errorMessage } from "@/lib/utils";
import { useApp } from "./app";
import { screenContextOf } from "@/lib/screenContext";
import { useUi, type MissionTab, type SettingsSection, type View } from "./ui";

interface VaStore extends VaState {
  /** Panel is showing (live session, or an error/summary that hasn't been dismissed). */
  visible: boolean;
  dismiss: () => void;
}

export const useVa = create<VaStore>((set) => ({
  ...initialVa,
  visible: false,
  dismiss: () => set({ ...initialVa, visible: false }),
}));

/** Screens the assistant can open by name (the tool's names match the window's). */
const SCREENS: ReadonlySet<string> = new Set(["usage", "schedules", "accounts", "settings", "compare"]);

const SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  "appearance", "sounds", "notifications", "behavior", "budgets", "templates", "projects", "toolkit",
  "providers", "tools", "agents", "remote", "voice", "assistant", "about",
]); // prettier-ignore

export function applyNavigation(view: string, agentId: string | null, section: string | null = null) {
  const ui = useUi.getState();
  if (view === "mission_control") {
    if (section === "needs" || section === "all") ui.openMission(section as MissionTab);
    else ui.setView("mission");
  } else if (view === "settings")
    ui.openSettings(section && SETTINGS_SECTIONS.has(section) ? (section as SettingsSection) : undefined);
  else if (SCREENS.has(view)) ui.setView(view as View);
  else if (view === "inbox")
    ui.openMission("needs"); // the tool's name for Needs you
  else if (view === "review" && agentId) {
    ui.openAgent(agentId);
    ui.setReviewAgent(agentId);
  } else if (agentId) ui.openAgent(agentId);
  else ui.setView("agents");
}

/** Subscribe the store to the backend's assistant events. Returns an unsubscribe function. */
export function connectVoiceAssistant(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  const stopReporting = reportScreen();
  void onVaEvent((e: VaEvent) => {
    if (e.type === "navigate") applyNavigation(e.view, e.agentId, e.section ?? null);
    useVa.setState((s) => {
      const next = reduceVa(s, e);
      // A clean end closes the panel; an error stays up until dismissed.
      return e.type === "ended" && !e.error ? { ...next, visible: false } : next;
    });
    if (e.type === "ended" && !e.error && e.reason !== "ended") toast.info(`Voice assistant: ${e.reason}`);
  }).then((un) => {
    if (disposed) un();
    else unlisten = un;
  });
  return () => {
    disposed = true;
    unlisten?.();
    stopReporting();
  };
}

/** While a session is live, tell the backend what the window shows (screen, open agent, highlighted text). */
function reportScreen(): () => void {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = () => {
    if (!isLive(useVa.getState())) {
      last = "";
      return;
    }
    const ctx = screenContextOf(useUi.getState(), window.getSelection()?.toString());
    const key = JSON.stringify(ctx);
    if (key === last) return;
    last = key;
    api.vaSetScreen(ctx).catch(() => {});
  };
  // A drag-select fires many events: send once it settles.
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(push, 250);
  };
  const offUi = useUi.subscribe(soon);
  const offVa = useVa.subscribe((s, prev) => {
    if (isLive(s) !== isLive(prev)) push();
  });
  document.addEventListener("selectionchange", soon);
  push();
  return () => {
    clearTimeout(timer);
    offUi();
    offVa();
    document.removeEventListener("selectionchange", soon);
  };
}

/** The backend has a session the panel doesn't know about (e.g. after an error state): show it again. */
function resyncLive() {
  useVa.setState((s) => ({
    ...s,
    phase: isLive(s) ? s.phase : "listening",
    message: null,
    endedReason: null,
    visible: true,
  }));
}

async function backendActive(): Promise<boolean> {
  try {
    return await api.vaActive();
  } catch {
    return false;
  }
}

export async function startVoiceAssistant(): Promise<void> {
  const ui = useUi.getState();
  if (!useApp.getState().settings?.voiceAssistant.enabled) {
    ui.openSettings("assistant");
    return;
  }
  if (isLive(useVa.getState())) return;
  // The backend is the source of truth: a session can outlive what the panel believes.
  if (await backendActive()) {
    resyncLive();
    return;
  }
  useVa.setState({ ...beginVa(), visible: true });
  try {
    await api.vaStart();
  } catch (e) {
    if (await backendActive()) {
      resyncLive();
      return;
    }
    useVa.setState({ ...initialVa, visible: false });
    toast.error("Couldn't start the voice assistant", { description: errorMessage(e) });
  }
}

export async function stopVoiceAssistant(): Promise<void> {
  try {
    await api.vaStop();
  } catch {
    /* already gone */
  }
}

/** Title-bar / composer / shortcut toggle: unmutes a paused session, stops one that is
 * active, starts one otherwise. */
export function toggleVoiceAssistant(): void {
  if (useVa.getState().phase === "paused") {
    setVaMuted(false);
    return;
  }
  void (async () => {
    if (isLive(useVa.getState()) || (await backendActive())) await stopVoiceAssistant();
    else await startVoiceAssistant();
  })();
}

/** Esc: end the session if one is active (even if the panel thinks it is over), else dismiss the panel. */
export async function escapeVoiceAssistant(): Promise<void> {
  if (isLive(useVa.getState()) || (await backendActive())) await stopVoiceAssistant();
  else useVa.getState().dismiss();
}

/** Answer a confirmation card. The card goes away at once so it can't be answered twice. */
export function answerVaConfirm(id: string, accept: boolean): void {
  useVa.setState((s) => ({ confirms: s.confirms.filter((c) => c.id !== id) }));
  void api.vaConfirm(id, accept).catch(() => {});
}

/** Mute (pause listening) or unmute. The backend closes the microphone and the connection
 * and reports the new state with a `va-event`, so the panel only changes when that is true. */
export function setVaMuted(muted: boolean): void {
  void api.vaSetMuted(muted).catch(() => {});
}
