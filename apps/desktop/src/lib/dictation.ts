// Voice dictation state, shared by every composer. One recording at a time; the
// composer picked by pickTarget receives the text.
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
  /** The target's mic button (its position in the page decides which composer a shortcut means). */
  el?: () => Element | null;
}

/** Minimal DOM surface the picker needs (lets it be tested without a DOM). */
export interface NodeLike {
  contains(other: unknown): boolean;
}
export interface Candidate {
  id: string;
  /** The mic button. */
  el: unknown;
  /** Its composer / dialog region, or null when it isn't in one. */
  scope: NodeLike | null;
  visible: boolean;
}

/**
 * Which target the shortcut dictates into: the one whose region holds the focused element, else
 * one inside the topmost open dialog (never a composer hidden behind it), else the visible page
 * composer. Later registrations win ties.
 */
export function pickTarget(cands: Candidate[], active: unknown, topDialog: NodeLike | null): string | null {
  for (let i = cands.length - 1; i >= 0; i--) {
    const c = cands[i];
    if (c.scope && active && c.scope.contains(active)) return c.id;
  }
  if (topDialog) {
    for (let i = cands.length - 1; i >= 0; i--) {
      if (cands[i].el && topDialog.contains(cands[i].el)) return cands[i].id;
    }
    return null;
  }
  for (let i = cands.length - 1; i >= 0; i--) if (cands[i].visible) return cands[i].id;
  return null;
}

function pickLiveTarget(): DictationTarget | undefined {
  const dialogs = document.querySelectorAll('[role="dialog"]');
  const topDialog = dialogs.length ? dialogs[dialogs.length - 1] : null;
  const cands: Candidate[] = targets.map((t) => {
    const el = t.el?.() ?? null;
    const scope = el ? el.closest("[data-dictation-scope], [role=dialog]") : null;
    const visible = !!el && el.isConnected && !el.closest("[role=dialog]") && (el as HTMLElement).offsetParent !== null;
    return { id: t.id, el, scope, visible };
  });
  const id = pickTarget(cands, document.activeElement, topDialog);
  return targets.find((t) => t.id === id);
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
let generation = 0;

let keyBound = false;
let levelOff = false;
let limitOff = false;

function ensureListeners() {
  if (!keyBound) {
    keyBound = true;
    window.addEventListener("keydown", onKey, true);
  }
  // Listener setup can fail (bridge not ready): leave the flag unset so the next registration retries.
  if (!levelOff) {
    levelOff = true;
    onVoiceLevel((e) => {
      if (useDictation.getState().phase === "recording")
        useDictation.setState({ level: e.level, elapsedMs: e.elapsedMs });
    }).catch(() => {
      levelOff = false;
    });
  }
  if (!limitOff) {
    limitOff = true;
    onVoiceLimit(() => {
      if (useDictation.getState().phase === "recording") {
        const mins = Math.max(1, Math.round(useDictation.getState().maxMs / 60_000));
        toast.info(`Reached the ${mins} minute limit; transcribing what was recorded`);
        void stopDictation();
      }
    }).catch(() => {
      limitOff = false;
    });
  }
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
  if (phase !== "recording" && phase !== "starting") return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    void cancelDictation();
  } else if (phase === "recording" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
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
    if (s.owner === target.id && (s.phase === "recording" || s.phase === "starting")) void cancelDictation();
  };
}

export async function toggleDictation(targetId?: string): Promise<void> {
  const s = useDictation.getState();
  if (s.phase === "recording") return stopDictation();
  if (s.phase !== "idle") return;
  const target = targetId ? targets.find((t) => t.id === targetId) : pickLiveTarget();
  if (!target) {
    if (!targetId) toast.info("Click a message box to dictate into it");
    return;
  }
  const gen = ++generation;
  useDictation.setState({ phase: "starting", owner: target.id, level: 0, elapsedMs: 0 });
  try {
    const status = await api.voiceStatus();
    if (gen !== generation) return;
    if (!status.ready) {
      useDictation.setState({ phase: "idle", owner: null, setupOpen: true });
      return;
    }
    useDictation.setState({ maxMs: status.maxRecordingSecs * 1000 });
    await api.voiceStart();
    // Cancelled (Esc, composer closed) while the recorder was starting: stop it again.
    if (
      gen !== generation ||
      useDictation.getState().owner !== target.id ||
      useDictation.getState().phase !== "starting"
    ) {
      // Only stop the recorder if no newer start owns it.
      if (gen === generation || useDictation.getState().phase === "idle") await api.voiceCancel().catch(() => {});
      return;
    }
    useDictation.setState({ phase: "recording" });
  } catch (e) {
    if (gen !== generation) return;
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
  generation++;
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
