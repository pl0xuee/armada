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

export async function startVoiceAssistant(): Promise<void> {
  const ui = useUi.getState();
  if (!useApp.getState().settings?.voiceAssistant.enabled) {
    ui.openSettings("assistant");
    return;
  }
  if (isLive(useVa.getState())) return;
  useVa.setState({ ...beginVa(), visible: true });
  try {
    await api.vaStart();
  } catch (e) {
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

export function toggleVoiceAssistant(): void {
  if (isLive(useVa.getState())) void stopVoiceAssistant();
  else void startVoiceAssistant();
}

export function setVaMuted(muted: boolean): void {
  useVa.setState({ muted });
  void api.vaSetMuted(muted).catch(() => {});
}
