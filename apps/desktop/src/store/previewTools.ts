// Preferences for the Preview pane's page tools (persisted).
import { create } from "zustand";

const KEY = "armada.previewTools.v1";

interface Prefs {
  /** Route the preview through the local proxy (screenshots, console, element picker). */
  tools: boolean;
  /** Attach a cropped screenshot of the element when picking one. */
  pickShot: boolean;
}

function load(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return { tools: p.tools !== false, pickShot: p.pickShot !== false };
  } catch {
    return { tools: true, pickShot: true };
  }
}

export const usePreviewTools = create<Prefs>(() => load());

export function setPreviewToolPref(p: Partial<Prefs>) {
  usePreviewTools.setState(p);
  try {
    const { tools, pickShot } = usePreviewTools.getState();
    localStorage.setItem(KEY, JSON.stringify({ tools, pickShot }));
  } catch {
    /* storage unavailable: the choice still applies for this session */
  }
}
