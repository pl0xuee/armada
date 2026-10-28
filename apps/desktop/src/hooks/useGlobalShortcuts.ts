import { useEffect } from "react";
import { orderedAgents } from "@/lib/agents";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

/** App-wide keyboard shortcuts. Mod = ⌘ on macOS, Ctrl elsewhere. */
export function useGlobalShortcuts(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const ui = useUi.getState();
      const key = e.key.toLowerCase();

      if (key === "k" && !e.shiftKey) {
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        ui.setPaletteOpen(false);
        ui.openNewAgent();
        return;
      }
      if (key === "i" && !e.shiftKey) {
        e.preventDefault();
        ui.setView("inbox");
        return;
      }
      if (key === "m" && e.shiftKey) {
        e.preventDefault();
        ui.setView("mission");
        return;
      }
      if (e.key === "," && !e.shiftKey) {
        e.preventDefault();
        ui.openSettings();
        return;
      }
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const list = orderedAgents(Object.values(useApp.getState().agents));
        const target = list[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          ui.openAgent(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
