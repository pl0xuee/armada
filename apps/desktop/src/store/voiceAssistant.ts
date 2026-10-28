import { toast } from "sonner";
import { create } from "zustand";
import { api, onVaEvent } from "@/lib/api";
import { beginVa, initialVa, isLive, reduceVa, type VaEvent, type VaState } from "@/lib/voiceAssistant";
import { errorMessage } from "@/lib/utils";
import { useApp } from "./app";
import { useUi } from "./ui";

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

function applyNavigation(view: string, agentId: string | null) {
  const ui = useUi.getState();
  if (view === "mission_control") ui.setView("mission");
  else if (view === "inbox") ui.setView("inbox");
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
  void onVaEvent((e: VaEvent) => {
    if (e.type === "navigate") applyNavigation(e.view, e.agentId);
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

/** Title-bar / composer / shortcut toggle: stops a session that is active, starts one otherwise. */
export function toggleVoiceAssistant(): void {
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

export function setVaMuted(muted: boolean): void {
  useVa.setState({ muted });
  void api.vaSetMuted(muted).catch(() => {});
}
