import { useEffect } from "react";
import { orderedAgents } from "@/lib/agents";
import { LIST_DOCK_QUERY } from "@/lib/layout";
import { selectNextTriage, triageQueueNow } from "@/components/triage/useTriage";
import { toggleAgentList } from "./useAgentListLayout";
import { isEditableTarget, isMac } from "@/lib/utils";
import { openShortcutHelp, toggleShortcutHelp } from "@/components/shell/ShortcutHelp";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

/** App-wide keyboard shortcuts. Mod = ⌘ on macOS, Ctrl elsewhere. */
export function useGlobalShortcuts(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // ⌘ on macOS, Ctrl elsewhere (Ctrl+K on a Mac is a text-editing shortcut).
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      // "?" (not while typing) opens the shortcut cheat sheet.
      if (!mod && e.key === "?" && !e.altKey && !e.repeat && !isEditableTarget(e.target) && !dialogOpen()) {
        e.preventDefault();
        openShortcutHelp();
        return;
      }
      if (!mod || e.altKey) return;
      const ui = useUi.getState();
      const key = e.key.toLowerCase();

      if (e.key === "/" && !e.shiftKey) {
        e.preventDefault();
        toggleShortcutHelp();
        return;
      }

      if (key === "k" && !e.shiftKey) {
        // The palette toggles itself; any other open dialog blocks it.
        if (!ui.paletteOpen && dialogOpen()) return;
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      // Never navigate out from under an open dialog, sheet or menu.
      if (dialogOpen()) return;
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        ui.setPaletteOpen(false);
        ui.openNewAgent();
        return;
      }
      if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        if (ui.view !== "agents") {
          ui.setView("agents");
          const layout = window.matchMedia(LIST_DOCK_QUERY).matches ? "wide" : "narrow";
          ui.setAgentList(layout, true);
        } else {
          toggleAgentList();
        }
        return;
      }
      if (key === "j" && !e.shiftKey) {
        e.preventDefault();
        // Opens "Needs you"; pressed again while it's open, moves to the next waiting agent.
        if (ui.view === "triage") selectNextTriage(triageQueueNow());
        else ui.setView("triage");
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

function dialogOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
  );
}
