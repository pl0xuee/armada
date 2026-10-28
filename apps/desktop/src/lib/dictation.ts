// Voice dictation state, shared by every composer. One recording at a time; the
// composer that is currently mounted (the last one registered) receives the text.
// Audio is captured and transcribed in the Rust core, entirely on this device.

import { toast } from "sonner";
import { create } from "zustand";
import { api, isTauri, onVoiceLevel, onVoiceLimit } from "./api";
import { errorMessage, isMac } from "./utils";

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

export interface DictationTarget {
  id: string;
  /** Called with the transcript; `autoSend` when the user asked to send after dictating. */
  insert: (text: string, autoSend: boolean) => void;
}

interface DictationState {
  phase: DictationPhase;
  /** The composer that owns the current recording. */
  owner: string | null;
  level: number;
  elapsedMs: number;
  maxMs: number;
  setupOpen: boolean;
  setSetupOpen: (open: boolean) => void;
}

export const useDictation = create<DictationState>((set) => ({
  phase: "idle",
  owner: null,
  level: 0,
  elapsedMs: 0,
  maxMs: 5 * 60_000,
  setupOpen: false,
  setSetupOpen: (setupOpen) => set({ setupOpen }),
}));

const targets: DictationTarget[] = [];
let listening = false;

function ensureListeners() {
  if (listening) return;
  listening = true;
  void onVoiceLevel((e) => {
    if (useDictation.getState().phase === "recording")
      useDictation.setState({ level: e.level, elapsedMs: e.elapsedMs });
  });
  void onVoiceLimit(() => {
    if (useDictation.getState().phase === "recording") {
      toast.info("Reached the 5 minute limit; transcribing what was recorded");
      void stopDictation();
    }
  });
  window.addEventListener("keydown", onKey, true);
}

function onKey(e: KeyboardEvent) {
  const { phase } = useDictation.getState();
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") {
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) void toggleDictation();
    return;
  }
  if (phase !== "recording") return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    void cancelDictation();
  } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.stopPropagation();
    void stopDictation();
  }
}

/** Registers a composer as the place dictated text goes; returns the unregister function. */
export function registerDictationTarget(target: DictationTarget): () => void {
  ensureListeners();
  targets.push(target);
  return () => {
    const i = targets.indexOf(target);
    if (i >= 0) targets.splice(i, 1);
    const s = useDictation.getState();
    if (s.owner === target.id && s.phase === "recording") void cancelDictation();
  };
}

export async function toggleDictation(targetId?: string): Promise<void> {
  const s = useDictation.getState();
  if (s.phase === "recording") return stopDictation();
  if (s.phase !== "idle") return;
  const target = targetId ? targets.find((t) => t.id === targetId) : targets[targets.length - 1];
  if (!target) return;
  useDictation.setState({ phase: "starting", owner: target.id, level: 0, elapsedMs: 0 });
  try {
    const status = await api.voiceStatus();
    if (!status.ready) {
      useDictation.setState({ phase: "idle", owner: null, setupOpen: true });
      return;
    }
    useDictation.setState({ maxMs: status.maxRecordingSecs * 1000 });
    await api.voiceStart();
    useDictation.setState({ phase: "recording" });
  } catch (e) {
    useDictation.setState({ phase: "idle", owner: null });
    toast.error("Couldn't start dictation", { description: errorMessage(e) });
  }
}

export async function stopDictation(): Promise<void> {
  const { phase, owner } = useDictation.getState();
  if (phase !== "recording") return;
  useDictation.setState({ phase: "transcribing", level: 0 });
  try {
    const t = await api.voiceStop();
    const target = targets.find((x) => x.id === owner);
    if (!t.text) {
      toast.info("Didn't catch anything. Check your microphone and try again.");
    } else if (target) {
      target.insert(t.text, t.autoSend);
    } else {
      toast.info("Dictation finished, but the composer was closed", { description: t.text });
    }
  } catch (e) {
    toast.error("Dictation failed", { description: errorMessage(e) });
  } finally {
    useDictation.setState({ phase: "idle", owner: null });
  }
}

export async function cancelDictation(): Promise<void> {
  const { phase } = useDictation.getState();
  if (phase !== "recording" && phase !== "starting") return;
  useDictation.setState({ phase: "idle", owner: null, level: 0 });
  try {
    await api.voiceCancel();
  } catch {
    // The recorder is gone either way.
  }
}

/** Dictation needs the desktop app (or the browser mock): not the mobile companion. */
export const dictationAvailable = () => isTauri() || import.meta.env.DEV || import.meta.env.VITE_ARMADA_MOCK === "1";

export const DICTATION_KEYS = [isMac ? "⌘" : "Ctrl", "⇧", "D"];
